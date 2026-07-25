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

/**
 * A d3-force that pulls every node gently toward the origin.
 *
 * Written by hand because force-graph bundles d3-force but does not re-export its
 * force factories. The shape (a function of alpha, with an `initialize` hook) is
 * the whole contract d3 asks of a custom force.
 */
function containForce(strength) {
  var nodes = [];
  function force(alpha) {
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      node.vx -= node.x * strength * alpha;
      node.vy -= node.y * strength * alpha;
    }
  }
  force.initialize = function (suppliedNodes) { nodes = suppliedNodes; };
  return force;
}

/**
 * A d3-force that stops nodes from overlapping.
 *
 * Repulsion alone spaces out the graph as a whole but says nothing about a node's
 * physical size, so two papers pulled together by a strong link end up drawn on
 * top of each other. Bucketing by a uniform grid keeps this near-linear instead of
 * comparing every pair — a whole library ticks 60 times a second either way.
 */
function collideForce(radiusOf, padding, strength) {
  var nodes = [];
  var radii = [];
  function force() {
    var count = nodes.length;
    if (!count) { return; }
    var largest = 0;
    var i;
    for (i = 0; i < count; i += 1) {
      if (radii[i] > largest) { largest = radii[i]; }
    }
    var cell = (largest + padding) * 2 || 1;
    var buckets = new Map();
    for (i = 0; i < count; i += 1) {
      var key = Math.round(nodes[i].x / cell) + ":" + Math.round(nodes[i].y / cell);
      var bucket = buckets.get(key);
      if (bucket) { bucket.push(i); } else { buckets.set(key, [i]); }
    }
    for (i = 0; i < count; i += 1) {
      var node = nodes[i];
      var cx = Math.round(node.x / cell);
      var cy = Math.round(node.y / cell);
      for (var ox = -1; ox <= 1; ox += 1) {
        for (var oy = -1; oy <= 1; oy += 1) {
          var neighbours = buckets.get((cx + ox) + ":" + (cy + oy));
          if (!neighbours) { continue; }
          for (var n = 0; n < neighbours.length; n += 1) {
            var j = neighbours[n];
            // Each pair is resolved once, and a node never collides with itself.
            if (j <= i) { continue; }
            var other = nodes[j];
            var dx = (other.x + other.vx) - (node.x + node.vx);
            var dy = (other.y + other.vy) - (node.y + node.vy);
            var wanted = radii[i] + radii[j] + padding;
            var squared = dx * dx + dy * dy;
            if (squared >= wanted * wanted) { continue; }
            // Perfectly coincident nodes have no direction to separate along, so
            // a nudge picks one instead of dividing by zero.
            var distance = Math.sqrt(squared);
            if (!distance) {
              dx = 1e-6;
              dy = 1e-6;
              distance = Math.sqrt(2) * 1e-6;
            }
            var push = ((wanted - distance) / distance) * strength * 0.5;
            dx *= push;
            dy *= push;
            node.vx -= dx;
            node.vy -= dy;
            other.vx += dx;
            other.vy += dy;
          }
        }
      }
    }
  }
  force.initialize = function (suppliedNodes) {
    nodes = suppliedNodes;
    radii = nodes.map(radiusOf);
  };
  return force;
}

var LiteratureGraph = {
  /**
   * Node radius and colour read from data, per the design's visual encoding:
   * size = in-library degree (a paper connected to more of your library is
   * bigger), colour = year (older cool, newer warm).
   *
   * Radii are in simulation units and only mean anything relative to LINK_DISTANCE:
   * the view is always zoom-to-fit, so what reads as "spread out" or "clumped" is
   * the ratio between how far links pull and how big nodes are, never the absolute
   * numbers.
   */
  LINK_DISTANCE: 250,
  REPEL_STRENGTH: -1000,
  CENTER_STRENGTH: 0.09,
  MIN_RADIUS: 8,
  MAX_RADIUS: 40,
  /** Below this on-screen radius a label is unreadable clutter, so it is skipped. */
  LABEL_MIN_PX: 5,
  LABEL_PX: 11,

  /**
   * Wrap a callback that force-graph invokes from inside its render loop.
   *
   * The loop ends with `state.animationFrameRequestId = requestAnimationFrame(...)`
   * and has no error handling of its own, so anything that throws on the way there
   * — a hover handler, a paint function — stops the loop being rescheduled and
   * freezes the canvas for good. Swallowing here keeps a display bug a display bug.
   */
  guard(view, name, fn) {
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (error) {
        LiteratureGraph.reportError(view, name, error);
        return undefined;
      }
    };
  },

  reportError(view, name, error) {
    var message = name + ": " + (error && error.message ? error.message : String(error));
    if (typeof console !== "undefined" && console.error) {
      console.error("[UniZero graph] " + message, error);
    }
    // Only the first failure is worth surfacing; a throwing paint callback would
    // otherwise report itself sixty times a second.
    if (view.lastError) { return; }
    view.lastError = message;
    if (view.options.onError) {
      try { view.options.onError(message); } catch (ignored) { /* never recurse */ }
    }
  },

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
    this.startWatchdog(view);
    return view;
  },

  /**
   * Restart the render loop if it ever stops advancing.
   *
   * The guards above cover callbacks we control, but the loop is a single
   * unprotected `requestAnimationFrame` chain: one unforeseen throw anywhere in it
   * and the canvas is frozen until the window is reopened. A frame counter makes
   * that state detectable, and pause-then-resume is what restarts it — resume alone
   * is a no-op, because the stale frame id left behind looks like a live loop.
   */
  startWatchdog(view) {
    var self = this;
    var last = -1;
    view.watchdog = window.setInterval(function () {
      var frames = view.frames || 0;
      if (frames !== last) {
        last = frames;
        return;
      }
      // A hidden container legitimately stops painting; only revive a visible one.
      if (!view.container || !view.container.clientWidth) { return; }
      try {
        view.graph.pauseAnimation();
        view.graph.resumeAnimation();
        view.revivals = (view.revivals || 0) + 1;
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[UniZero graph] render loop stalled; restarted it");
        }
        // Reviving repeatedly means the cause is still there, and silently
        // restarting forever would hide it. Say so once and keep going.
        if (view.revivals === 3) {
          self.reportError(
            view,
            "render loop",
            new Error("keeps stalling; see the console for the underlying error"),
          );
        }
      } catch (error) {
        self.reportError(view, "watchdog", error);
      }
    }, 1500);
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
    var container = view.container;
    var guard = function (name, fn) { return self.guard(view, name, fn); };

    graph
      .backgroundColor(this.background(view))
      // Node painting depends on external state (hover, selection, neighbours),
      // which the redraw loop cannot detect. Left on, the canvas stops repainting
      // once the engine settles and every interaction looks dead.
      .autoPauseRedraw(false)
      .nodeId("id")
      .nodeRelSize(1)
      .nodeVal(guard("nodeVal", function (node) { return self.radius(view, node); }))
      .nodeLabel(function () { return ""; }) // hover card is rendered by the explorer
      .linkColor(guard("linkColor", function (link) {
        return self.linkColor(view, link);
      }))
      .linkWidth(guard("linkWidth", function (link) {
        return self.linkWidth(view, link);
      }))
      .linkDirectionalArrowLength(function (link) {
        return link.type === "cites" ? 9 : 0;
      })
      .linkDirectionalArrowRelPos(0.92)
      .linkDirectionalParticles(guard("particles", function (link) {
        // Particles only on the highlighted subgraph: constant motion everywhere
        // is noise, but on hover it reads as direction of citation.
        return view.hoverId && self.touchesHover(view, link) && link.type === "cites"
          ? 2
          : 0;
      }))
      .linkDirectionalParticleWidth(5)
      .linkDirectionalParticleSpeed(0.006)
      .nodeCanvasObject(guard("drawNode", function (node, ctx, scale) {
        self.drawNode(view, node, ctx, scale);
      }))
      .nodePointerAreaPaint(guard("pointerArea", function (node, color, ctx) {
        var radius = self.radius(view, node) + 4;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
        ctx.fill();
      }))
      .onNodeHover(guard("onNodeHover", function (node) {
        view.hoverId = node ? node.id : null;
        self.recomputeNeighbours(view);
        container.style.cursor = node ? "pointer" : "default";
        if (view.options.onHover) { view.options.onHover(node || null); }
      }))
      .onNodeClick(guard("onNodeClick", function (node, event) {
        // force-graph has no double-click event, so the click count off the
        // MouseEvent is what separates "select" from "open".
        if (node && event && event.detail >= 2) {
          if (view.options.onOpen) { view.options.onOpen(node); }
          return;
        }
        // Select and recentre; deliberately NOT an open.
        self.select(view, node ? node.id : null);
        if (node) { graph.centerAt(node.x, node.y, 420); }
        if (view.options.onSelect) { view.options.onSelect(node || null); }
      }))
      .onNodeRightClick(guard("onNodeRightClick", function (node) {
        if (node && view.options.onContext) { view.options.onContext(node); }
      }))
      .onBackgroundClick(guard("onBackgroundClick", function () {
        self.select(view, null);
        if (view.options.onSelect) { view.options.onSelect(null); }
      }))
      .onNodeDragEnd(guard("onNodeDragEnd", function (node) {
        // Pin a dragged node, matching the mental model of arranging a board.
        node.fx = node.x;
        node.fy = node.y;
      }))
      // A frame counter is the only reliable way to tell a settled graph from a
      // dead render loop; the watchdog reads it.
      .onRenderFramePost(function () { view.frames = (view.frames || 0) + 1; });

    // Papers with no connections have nothing pulling them back, so charge alone
    // pushes them past the horizon — and zoom-to-fit then shrinks the real cluster
    // to a dot. A weak pull toward the origin keeps them in a loose orbit, the way
    // orphan notes sit around the edge of a graph view.
    graph.d3Force("contain", containForce(this.CENTER_STRENGTH));
    // Nodes have a drawn size that repulsion knows nothing about, so without this
    // two strongly linked papers are painted on top of each other.
    graph.d3Force("collide", collideForce(
      function (node) { return self.radius(view, node); },
      6,
      0.7,
    ));

    // Link distance and repulsion only matter as a ratio, and these proportions are
    // the ones a graph view of this kind needs: an order of magnitude more repulsion
    // than a default d3 layout, over links four times longer. Anything tighter and a
    // real library collapses into one illegible blob.
    var linkForce = graph.d3Force("link");
    if (linkForce && linkForce.distance) {
      // Coupling should pull related papers together; citation links stay looser so
      // the layout reflects similarity rather than pure reference direction.
      linkForce.distance(guard("linkDistance", function (link) {
        return link.type === "coupled"
          ? Math.max(self.LINK_DISTANCE * 0.45, self.LINK_DISTANCE - link.weight * 22)
          : self.LINK_DISTANCE;
      }));
    }
    var chargeForce = graph.d3Force("charge");
    if (chargeForce && chargeForce.strength) {
      chargeForce.strength(this.REPEL_STRENGTH);
      // Bounding the far field keeps a large library from inflating without limit
      // while still letting clusters push each other apart.
      if (chargeForce.distanceMax) { chargeForce.distanceMax(this.LINK_DISTANCE * 12); }
    }
  },

  radius(view, node) {
    var degree = Number(node.degree || 0);
    // sqrt keeps a hub from dwarfing everything else.
    var scaled = this.MIN_RADIUS + Math.sqrt(degree) * 5;
    var radius = Math.min(this.MAX_RADIUS, scaled);
    return node.id === view.centerId ? radius * 1.15 + 3 : radius;
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
    if (view.hoverId && this.touchesHover(view, link)) { return 7; }
    return link.type === "coupled"
      ? Math.min(10, 2 + Number(link.weight || 1) * 1.4)
      : 2;
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
      ctx.lineWidth = node.id === view.centerId ? 8 : 6;
      ctx.strokeStyle = node.id === view.centerId
        ? view.theme.orange
        : view.theme.accent;
      ctx.stroke();
    } else if (node.hasMarkdown) {
      // A converted paper gets a quiet ring: it is the one state worth seeing
      // across the whole board while scanning.
      ctx.lineWidth = 4;
      ctx.strokeStyle = this.withAlpha(view.theme.green, 0.85);
      ctx.stroke();
    }

    // Decluttering, in screen pixels rather than simulation units: a label is worth
    // drawing once its node is actually big enough to read next to. Zoomed out, that
    // leaves only hubs and whatever the pointer is on, which is the whole point —
    // every label at once turns a real library into a mat of text.
    var important = node.id === view.centerId || node.id === view.selectedId ||
      node.id === view.hoverId || view.neighbours.has(node.id);
    if (!important &&
        (radius * scale < this.LABEL_MIN_PX || node.degree < view.labelDegree)) {
      ctx.globalAlpha = 1;
      return;
    }
    var label = node.label || "";
    if (!label) { ctx.globalAlpha = 1; return; }
    // Dividing by the zoom keeps text a constant size on screen at any zoom level.
    var fontSize = this.LABEL_PX / scale;
    ctx.font = fontSize + "px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = dim ? this.withAlpha(view.theme.muted, 0.5) : view.theme.fg;
    ctx.fillText(label, node.x, node.y + radius + fontSize * 0.35);
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

  /**
   * Frame the connected core rather than the full extent.
   *
   * Fitting everything lets a handful of unconnected papers on the rim decide the
   * zoom, leaving the part worth reading a few pixels wide. Orphans stay on the
   * canvas — they are simply not what the view is scaled to.
   */
  zoomToFit(view, milliseconds, padding) {
    if (!view.graph) { return; }
    var connected = view.data && view.data.nodes.some(function (node) {
      return node.degree > 0;
    });
    try {
      view.graph.zoomToFit(
        milliseconds === undefined ? 420 : milliseconds,
        padding === undefined ? 42 : padding,
        function (node) { return connected ? node.degree > 0 : true; },
      );
    } catch (error) { /* nothing laid out yet */ }
  },

  /** Bring the focal paper of an ego view to the middle of the canvas. */
  centerOnFocus(view, milliseconds) {
    if (!view || !view.graph || !view.centerId) { return; }
    var focus = view.data.nodes.find(function (node) {
      return node.id === view.centerId;
    });
    if (!focus || typeof focus.x !== "number") { return; }
    try {
      view.graph.centerAt(focus.x, focus.y, milliseconds === undefined ? 500 : milliseconds);
    } catch (error) { /* not laid out yet */ }
  },

  destroy(view) {
    if (view && view.watchdog) {
      window.clearInterval(view.watchdog);
      view.watchdog = null;
    }
    if (view && view.graph && view.graph._destructor) {
      try { view.graph._destructor(); } catch (error) { /* already gone */ }
    }
    if (view && view.container) { view.container.innerHTML = ""; }
  },
};
