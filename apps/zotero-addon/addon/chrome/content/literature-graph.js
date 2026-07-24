/**
 * Canvas graph view for the Literature Explorer.
 *
 * Wraps the vendored force-graph (window.ForceGraph) behind a small facade so the
 * explorer never touches renderer specifics: it hands over a LiteratureGraphView
 * and a few callbacks, and everything else — theming, node encoding, label
 * decluttering, hover highlighting — lives here. Swapping the renderer for a WebGL
 * one later means rewriting this file only.
 *
 * Interaction follows the three-step model the design settled on: hover previews,
 * single click selects and recentres, double click opens. A single click must not
 * navigate, or the graph stops being explorable.
 */

"use strict";

var LiteratureGraph = {
  /**
   * Node radius and colour read from data, per the design's visual encoding:
   * size = in-library degree (a paper connected to more of your library is
   * bigger), colour = year (older cool, newer warm).
   */
  MIN_RADIUS: 3.2,
  MAX_RADIUS: 13,
  LABEL_ZOOM: 1.15,

  create(container, options) {
    if (typeof window.ForceGraph !== "function") {
      throw new Error("force-graph failed to load");
    }
    var view = {
      container: container,
      graph: null,
      data: { nodes: [], links: [] },
      selectedId: null,
      hoverId: null,
      neighbours: new Set(),
      centerId: null,
      theme: this.readTheme(),
      options: options || {},
    };
    view.graph = window.ForceGraph()(container);
    this.configure(view);
    this.watchTheme(view);
    return view;
  },

  /** Pull palette out of the stylesheet so the canvas matches the surrounding UI. */
  readTheme() {
    var style = getComputedStyle(document.documentElement);
    var read = function (name, fallback) {
      var value = style.getPropertyValue(name);
      return (value && value.trim()) || fallback;
    };
    return {
      accent: read("--accent", "#2f6fca"),
      fg: read("--fg", "#202124"),
      muted: read("--muted", "#68707b"),
      border: read("--border", "#d8dbe0"),
      card: read("--card", "#ffffff"),
      green: read("--green", "#2e7d45"),
      orange: read("--orange", "#a86200"),
      dark: window.matchMedia
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
        : false,
    };
  },

  watchTheme(view) {
    if (!window.matchMedia) { return; }
    var query = window.matchMedia("(prefers-color-scheme: dark)");
    var self = this;
    var onChange = function () {
      view.theme = self.readTheme();
      if (view.graph) { view.graph.backgroundColor(self.background(view)); }
    };
    if (query.addEventListener) {
      query.addEventListener("change", onChange);
    } else if (query.addListener) {
      query.addListener(onChange);
    }
  },

  background(view) {
    return view.theme.dark ? "#202124" : "#f7f8fa";
  },

  /** Blend a hex colour toward white/black; used for year shading and dimming. */
  shade(hex, amount) {
    var value = String(hex || "").replace("#", "");
    if (value.length === 3) {
      value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
    }
    if (value.length !== 6) { return hex; }
    var channels = [0, 2, 4].map(function (offset) {
      return parseInt(value.substr(offset, 2), 16);
    });
    var mixed = channels.map(function (channel) {
      var target = amount >= 0 ? 255 : 0;
      return Math.round(channel + (target - channel) * Math.abs(amount));
    });
    return "rgb(" + mixed.join(",") + ")";
  },

  withAlpha(hex, alpha) {
    var value = String(hex || "").replace("#", "");
    if (value.length === 3) {
      value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
    }
    if (value.length !== 6) { return hex; }
    var channels = [0, 2, 4].map(function (offset) {
      return parseInt(value.substr(offset, 2), 16);
    });
    return "rgba(" + channels.join(",") + "," + alpha + ")";
  },

  configure(view) {
    var self = this;
    var graph = view.graph;

    graph
      .backgroundColor(this.background(view))
      .nodeId("id")
      .nodeRelSize(1)
      .nodeVal(function (node) { return self.radius(view, node); })
      .nodeLabel(function () { return ""; }) // hover card is rendered by the explorer
      .linkColor(function (link) { return self.linkColor(view, link); })
      .linkWidth(function (link) { return self.linkWidth(view, link); })
      .linkDirectionalArrowLength(function (link) {
        return link.type === "cites" ? 2.6 : 0;
      })
      .linkDirectionalArrowRelPos(0.92)
      .linkDirectionalParticles(function (link) {
        // Particles only on the highlighted subgraph: constant motion everywhere
        // is noise, but on hover it reads as direction of citation.
        return view.hoverId && self.touchesHover(view, link) && link.type === "cites"
          ? 2
          : 0;
      })
      .linkDirectionalParticleWidth(1.6)
      .linkDirectionalParticleSpeed(0.006)
      .nodeCanvasObject(function (node, ctx, scale) {
        self.drawNode(view, node, ctx, scale);
      })
      .nodePointerAreaPaint(function (node, color, ctx) {
        var radius = self.radius(view, node) + 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
        ctx.fill();
      })
      .onNodeHover(function (node) {
        view.hoverId = node ? node.id : null;
        self.recomputeNeighbours(view);
        container.style.cursor = node ? "pointer" : "default";
        if (view.options.onHover) { view.options.onHover(node || null); }
      })
      .onNodeClick(function (node) {
        // Select and recentre; deliberately NOT an open.
        self.select(view, node ? node.id : null);
        if (node) { graph.centerAt(node.x, node.y, 420); }
        if (view.options.onSelect) { view.options.onSelect(node || null); }
      })
      .onNodeRightClick(function (node) {
        if (node && view.options.onContext) { view.options.onContext(node); }
      })
      .onBackgroundClick(function () {
        self.select(view, null);
        if (view.options.onSelect) { view.options.onSelect(null); }
      })
      .onNodeDragEnd(function (node) {
        // Pin a dragged node, matching the mental model of arranging a board.
        node.fx = node.x;
        node.fy = node.y;
      });

    if (graph.onNodeDoubleClick) {
      graph.onNodeDoubleClick(function (node) {
        if (node && view.options.onOpen) { view.options.onOpen(node); }
      });
    }

    // Coupling should pull related papers together; citation links stay looser so
    // the layout reflects similarity rather than pure reference direction.
    var linkForce = graph.d3Force("link");
    if (linkForce && linkForce.distance) {
      linkForce.distance(function (link) {
        return link.type === "coupled" ? Math.max(24, 70 - link.weight * 9) : 55;
      });
    }
    var chargeForce = graph.d3Force("charge");
    if (chargeForce && chargeForce.strength) { chargeForce.strength(-118); }
  },

  radius(view, node) {
    var degree = Number(node.degree || 0);
    // sqrt keeps a hub from dwarfing everything else.
    var scaled = this.MIN_RADIUS + Math.sqrt(degree) * 2.1;
    var radius = Math.min(this.MAX_RADIUS, scaled);
    return node.id === view.centerId ? radius + 2.2 : radius;
  },

  /** Year → colour ramp, cool (old) to warm (recent). */
  nodeColor(view, node) {
    var year = Number(node.year || 0);
    if (!year) { return view.theme.muted; }
    var span = view.yearMax - view.yearMin;
    var ratio = span > 0 ? (year - view.yearMin) / span : 0.5;
    var cold = [70, 130, 180];
    var warm = [214, 149, 60];
    var mixed = cold.map(function (channel, index) {
      return Math.round(channel + (warm[index] - channel) * ratio);
    });
    return "rgb(" + mixed.join(",") + ")";
  },

  touchesHover(view, link) {
    if (!view.hoverId) { return false; }
    var source = typeof link.source === "object" ? link.source.id : link.source;
    var target = typeof link.target === "object" ? link.target.id : link.target;
    return source === view.hoverId || target === view.hoverId;
  },

  recomputeNeighbours(view) {
    view.neighbours = new Set();
    if (!view.hoverId) { return; }
    view.data.links.forEach(function (link) {
      var source = typeof link.source === "object" ? link.source.id : link.source;
      var target = typeof link.target === "object" ? link.target.id : link.target;
      if (source === view.hoverId) { view.neighbours.add(target); }
      if (target === view.hoverId) { view.neighbours.add(source); }
    });
  },

  dimmed(view, nodeId) {
    if (!view.hoverId) { return false; }
    return nodeId !== view.hoverId && !view.neighbours.has(nodeId);
  },

  linkColor(view, link) {
    var base = link.type === "coupled" ? view.theme.accent : view.theme.muted;
    if (view.hoverId) {
      if (!this.touchesHover(view, link)) { return this.withAlpha(base, 0.05); }
      return this.withAlpha(base, 0.85);
    }
    // Coupling strength reads as opacity; citations stay faint so hubs do not
    // turn the canvas into a solid mat.
    var alpha = link.type === "coupled"
      ? Math.min(0.5, 0.14 + Number(link.weight || 1) * 0.09)
      : 0.22;
    return this.withAlpha(base, alpha);
  },

  linkWidth(view, link) {
    if (view.hoverId && this.touchesHover(view, link)) { return 1.8; }
    return link.type === "coupled"
      ? Math.min(2.4, 0.5 + Number(link.weight || 1) * 0.35)
      : 0.5;
  },

  drawNode(view, node, ctx, scale) {
    var radius = this.radius(view, node);
    var dim = this.dimmed(view, node.id);
    var color = this.nodeColor(view, node);

    ctx.globalAlpha = dim ? 0.2 : 1;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = color;
    ctx.fill();

    // Rings carry state: selection, ego centre, and hover all need to be legible
    // at a glance without changing the node's size or colour meaning.
    if (node.id === view.centerId || node.id === view.selectedId ||
        node.id === view.hoverId) {
      ctx.lineWidth = node.id === view.centerId ? 2.2 : 1.6;
      ctx.strokeStyle = node.id === view.centerId
        ? view.theme.orange
        : view.theme.accent;
      ctx.stroke();
    } else if (node.hasMarkdown) {
      // A converted paper gets a quiet ring: it is the one state worth seeing
      // across the whole board while scanning.
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = this.withAlpha(view.theme.green, 0.85);
      ctx.stroke();
    }

    // Decluttering: labels appear when zoomed in, for well-connected papers, or
    // for whatever the pointer/selection is on. Drawing all of them at once turns
    // a real library into an unreadable mat of text.
    var important = node.id === view.centerId || node.id === view.selectedId ||
      node.id === view.hoverId || view.neighbours.has(node.id);
    if (!important && (scale < this.LABEL_ZOOM || node.degree < view.labelDegree)) {
      ctx.globalAlpha = 1;
      return;
    }
    var label = node.label || "";
    if (!label) { ctx.globalAlpha = 1; return; }
    var fontSize = Math.max(2.5, Math.min(4.6, 11 / scale));
    ctx.font = fontSize + "px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = dim ? this.withAlpha(view.theme.muted, 0.5) : view.theme.fg;
    ctx.fillText(label, node.x, node.y + radius + 1.2);
    ctx.globalAlpha = 1;
  },

  /** Short, readable node label: first author surname + year, title as fallback. */
  labelFor(node) {
    var creator = (node.creators && node.creators[0]) || "";
    var surname = creator ? creator.split(/\s+/).pop() : "";
    var year = node.year || "";
    if (surname && year) { return surname + ", " + year; }
    if (surname) { return surname; }
    var title = String(node.title || "");
    return title.length > 28 ? title.slice(0, 27) + "…" : title;
  },

  setData(view, graphData, layout) {
    var self = this;
    var seeded = 0;
    var nodes = (graphData.nodes || []).map(function (node) {
      // A saved coordinate is only a starting point — the simulation still runs,
      // so a stale or partial layout converges instead of misplacing anything.
      var saved = layout && layout[node.id];
      if (saved && saved.length === 2) { seeded += 1; }
      return {
        x: saved ? saved[0] : undefined,
        y: saved ? saved[1] : undefined,
        id: node.id,
        itemKey: node.itemKey,
        itemID: node.itemID,
        degree: node.degree || 0,
        isCenter: node.isCenter,
        title: node.title,
        creators: node.creators || [],
        year: node.year,
        publicationTitle: node.publicationTitle,
        hasPDF: node.hasPDF,
        hasMarkdown: node.hasMarkdown,
        label: self.labelFor(node),
      };
    });
    var links = (graphData.edges || []).map(function (edge) {
      return {
        source: edge.source,
        target: edge.target,
        type: edge.type,
        weight: edge.weight || 1,
      };
    });

    var years = nodes
      .map(function (node) { return Number(node.year || 0); })
      .filter(function (year) { return year > 0; });
    view.yearMin = years.length ? Math.min.apply(null, years) : 0;
    view.yearMax = years.length ? Math.max.apply(null, years) : 0;
    // On a big board only the better-connected papers get a standing label.
    view.labelDegree = nodes.length > 120 ? 3 : (nodes.length > 45 ? 2 : 0);
    view.centerId = graphData.center || null;
    view.data = { nodes: nodes, links: links };
    view.hoverId = null;
    view.neighbours = new Set();

    // A mostly-seeded graph only needs to relax, not to lay itself out from
    // scratch; a cold one gets the full simulation.
    var warm = nodes.length > 0 && seeded >= nodes.length * 0.6;
    if (view.graph.d3AlphaDecay) { view.graph.d3AlphaDecay(warm ? 0.06 : 0.0228); }
    if (view.graph.cooldownTicks) { view.graph.cooldownTicks(warm ? 60 : Infinity); }

    view.graph.graphData(view.data);
    return { nodes: nodes.length, links: links.length, warm: warm };
  },

  /** Current coordinates, for persisting the layout. */
  snapshotPositions(view) {
    var positions = {};
    if (!view || !view.data) { return positions; }
    view.data.nodes.forEach(function (node) {
      if (typeof node.x === "number" && typeof node.y === "number") {
        // Rounded: sub-pixel precision is noise in a file that is only a seed.
        positions[node.id] = [Math.round(node.x * 10) / 10,
          Math.round(node.y * 10) / 10];
      }
    });
    return positions;
  },

  /** Run a callback once the simulation settles. */
  onSettled(view, callback) {
    if (!view || !view.graph || !view.graph.onEngineStop) { return; }
    view.graph.onEngineStop(function () { callback(); });
  },

  select(view, nodeId) {
    view.selectedId = nodeId;
  },

  resize(view) {
    if (!view.graph || !view.container) { return; }
    var width = view.container.clientWidth;
    var height = view.container.clientHeight;
    if (width > 0 && height > 0) { view.graph.width(width).height(height); }
  },

  zoomToFit(view, milliseconds, padding) {
    if (!view.graph) { return; }
    try {
      view.graph.zoomToFit(milliseconds === undefined ? 420 : milliseconds,
        padding === undefined ? 34 : padding);
    } catch (error) { /* nothing laid out yet */ }
  },

  destroy(view) {
    if (view && view.graph && view.graph._destructor) {
      try { view.graph._destructor(); } catch (error) { /* already gone */ }
    }
    if (view && view.container) { view.container.innerHTML = ""; }
  },
};
