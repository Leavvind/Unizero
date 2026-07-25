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
   * Node size = in-library degree: a paper connected to more of your library is
   * bigger. Fill is one neutral colour, with focus, selection, and hover swapping
   * it; colouring by year is opt-in (see nodeColor).
   *
   * Radii are in simulation units and only mean anything relative to the link
   * distance: the view is always zoom-to-fit, so what reads as "spread out" or
   * "clumped" is the ratio between how far links pull and how big nodes are, never
   * the absolute numbers.
   */
  MIN_RADIUS: 8,
  MAX_RADIUS: 40,
  LABEL_PX: 11,
  /** Screen pixels over which a label fades in once past the fade threshold. */
  LABEL_FADE_PX: 5,

  /**
   * Display and force settings the user can change, with the defaults the layout
   * was tuned against.
   *
   * Forces are in simulation units and only mean anything as a ratio to each other,
   * because the view is always zoom-to-fit. Display values are in screen pixels or
   * plain multipliers, so they mean the same thing at any zoom.
   */
  SETTINGS_DEFAULTS: {
    arrows: true,
    textFade: 5,
    nodeSize: 1,
    linkThickness: 1,
    colourBy: "none",
    centerForce: 0.09,
    repelForce: 1000,
    linkForce: 1,
    linkDistance: 250,
  },

  /** Bounds for anything read back from disk; a bad value must not break a render. */
  SETTINGS_LIMITS: {
    textFade: [0, 24],
    // Every step has to change something you can see. Below a quarter the nodes
    // stop being clickable targets, above two and a half a dense cluster is one
    // solid shape, so the travel outside this band was only ever wasted.
    nodeSize: [0.25, 2.5],
    linkThickness: [0.2, 5],
    centerForce: [0, 1],
    repelForce: [0, 4000],
    linkForce: [0, 4],
    linkDistance: [30, 800],
  },

  sanitizeSettings(settings) {
    var out = Object.assign({}, this.SETTINGS_DEFAULTS, settings || {});
    var limits = this.SETTINGS_LIMITS;
    Object.keys(limits).forEach(function (key) {
      // Number(null) is 0, which is a legal value for most of these — so a missing
      // entry has to be caught before the conversion, not after it.
      var raw = out[key];
      var value = (raw === null || raw === undefined || raw === "")
        ? NaN
        : Number(raw);
      if (!isFinite(value)) { value = LiteratureGraph.SETTINGS_DEFAULTS[key]; }
      out[key] = Math.min(limits[key][1], Math.max(limits[key][0], value));
    });
    out.arrows = Boolean(out.arrows);
    out.colourBy = out.colourBy === "year" ? "year" : "none";
    return out;
  },

  /**
   * Coordinates saved under one set of forces are meaningless under another, so the
   * layout file carries the signature of the forces that produced it.
   */
  forceSignature(settings) {
    var s = this.sanitizeSettings(settings);
    return [s.linkDistance, s.repelForce, s.centerForce, s.linkForce].join("|");
  },

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
      settings: this.sanitizeSettings((options || {}).settings),
    };
    view.graph = window.ForceGraph()(container);
    // The canvas is inside a privileged window whose default menu has nothing to do
    // with the graph; the node menu is the explorer's job.
    container.addEventListener("contextmenu", function (event) {
      event.preventDefault();
    });
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
      .nodeVal(guard("nodeVal", function (node) { return self.drawRadius(view, node); }))
      .nodeLabel(function () { return ""; }) // hover card is rendered by the explorer
      .linkColor(guard("linkColor", function (link) {
        return self.linkColor(view, link);
      }))
      .linkWidth(guard("linkWidth", function (link) {
        return self.linkWidth(view, link);
      }))
      .linkDirectionalArrowLength(guard("arrowLength", function (link) {
        return link.type === "cites" && view.settings.arrows ? 4 : 0;
      }))
      .linkDirectionalArrowRelPos(0.92)
      .linkDirectionalParticles(guard("particles", function (link) {
        // Particles only on the highlighted subgraph: constant motion everywhere
        // is noise, but on hover it reads as direction of citation.
        return view.hoverId && self.touchesHover(view, link) && link.type === "cites"
          ? 2
          : 0;
      }))
      .linkDirectionalParticleWidth(2)
      .linkDirectionalParticleSpeed(0.006)
      .nodeCanvasObject(guard("drawNode", function (node, ctx, scale) {
        self.drawNode(view, node, ctx, scale);
      }))
      .nodePointerAreaPaint(guard("pointerArea", function (node, color, ctx) {
        // Follows what is painted, and never shrinks below something clickable —
        // the smallest setting still has to be usable, not just visible.
        var radius = Math.max(self.drawRadius(view, node) + 4, 10);
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
      .onNodeRightClick(guard("onNodeRightClick", function (node, event) {
        // Right-click neither selects nor opens: the menu acts on the node under
        // the pointer, and the current selection stays where the user put it.
        if (node && view.options.onContext) { view.options.onContext(node, event); }
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

    this.applyForces(view);
  },

  /**
   * Install the four forces from the current settings.
   *
   * Called on creation and again whenever a force slider moves, so the arrangement
   * responds while the user drags rather than on the next open. Link distance and
   * repulsion only matter as a ratio: an order of magnitude more repulsion than a
   * default d3 layout, over links several times longer. Anything tighter and a real
   * library collapses into one illegible blob.
   */
  applyForces(view) {
    var self = this;
    var graph = view.graph;
    var settings = view.settings;
    var guard = function (name, fn) { return self.guard(view, name, fn); };
    if (!graph) { return; }

    // Papers with no connections have nothing pulling them back, so charge alone
    // pushes them past the horizon — and zoom-to-fit then shrinks the real cluster
    // to a dot. A weak pull toward the origin keeps them in a loose orbit, the way
    // orphan notes sit around the edge of a graph view.
    graph.d3Force("contain", containForce(settings.centerForce));
    // Nodes have a size that repulsion knows nothing about, so without this two
    // strongly linked papers end up in the same place. It reads the layout radius,
    // not the painted one: the node-size setting must not move anything.
    graph.d3Force("collide", collideForce(
      function (node) { return self.radius(view, node); },
      6,
      0.7,
    ));

    var linkForce = graph.d3Force("link");
    if (linkForce && linkForce.distance) {
      // Coupling should pull related papers together; citation links stay looser so
      // the layout reflects similarity rather than pure reference direction.
      linkForce.distance(guard("linkDistance", function (link) {
        return link.type === "coupled"
          ? Math.max(settings.linkDistance * 0.45,
            settings.linkDistance - link.weight * 22)
          : settings.linkDistance;
      }));
      // d3's own default is 1/min(degree) — keeping that shape and scaling it means
      // the slider reads as "how much stronger than normal", and a hub still does
      // not drag its whole neighbourhood into a knot.
      if (linkForce.strength) {
        linkForce.strength(guard("linkStrength", function (link) {
          var source = (link.source && link.source.degree) || 1;
          var target = (link.target && link.target.degree) || 1;
          return settings.linkForce / Math.max(1, Math.min(source, target));
        }));
      }
    }
    var chargeForce = graph.d3Force("charge");
    if (chargeForce && chargeForce.strength) {
      chargeForce.strength(-Math.abs(settings.repelForce));
      // Bounding the far field keeps a large library from inflating without limit
      // while still letting clusters push each other apart.
      if (chargeForce.distanceMax) {
        chargeForce.distanceMax(settings.linkDistance * 12);
      }
    }
  },

  /**
   * Adopt new settings on a live view.
   *
   * Display values are read by the paint callbacks every frame, so they need no more
   * than the assignment. Forces have to be reinstalled and the simulation reheated,
   * or the graph keeps the shape the old numbers produced.
   */
  applySettings(view, settings) {
    if (!view) { return null; }
    var previous = view.settings;
    view.settings = this.sanitizeSettings(settings);
    var forcesChanged = ["centerForce", "repelForce", "linkForce", "linkDistance"]
      .some(function (key) { return previous[key] !== view.settings[key]; });
    if (forcesChanged) {
      this.applyForces(view);
      if (view.graph && view.graph.d3ReheatSimulation) {
        try { view.graph.d3ReheatSimulation(); } catch (error) { /* not running */ }
      }
    }
    return view.settings;
  },

  /**
   * Radius the layout reasons about, in simulation units.
   *
   * Deliberately independent of the node-size setting. The view is always
   * zoom-to-fit, so a radius the collide force can see is a radius that inflates
   * the whole arrangement and is then divided straight back out by the fit: the
   * setting would cancel itself and leave only its side effect, nodes growing
   * against a link distance that did not grow with them.
   */
  radius(view, node) {
    var degree = Number(node.degree || 0);
    // sqrt keeps a hub from dwarfing everything else.
    var radius = Math.min(this.MAX_RADIUS, this.MIN_RADIUS + Math.sqrt(degree) * 5);
    return node.id === view.centerId ? radius * 1.15 + 3 : radius;
  },

  /** Radius actually painted: the layout radius scaled by the user's setting. */
  drawRadius(view, node) {
    return this.radius(view, node) * (view.settings.nodeSize || 1);
  },

  /**
   * Node fill.
   *
   * State owns the fill — focus, selection, and hover swap the colour rather than
   * adding a ring around the node, which is what keeps a dense board legible
   * instead of turning it into a field of targets. Colouring by year is off by
   * default: a continuous ramp across every node reads as noise at a glance, and
   * year is available as a filter when it is actually the question being asked.
   */
  nodeColor(view, node) {
    var theme = view.theme;
    if (node.id === view.centerId) { return theme.orange; }
    if (node.id === view.selectedId || node.id === view.hoverId) {
      return theme.accent;
    }
    if (view.settings.colourBy === "year") {
      var year = Number(node.year || 0);
      if (!year) { return theme.muted; }
      var span = view.yearMax - view.yearMin;
      var ratio = span > 0 ? (year - view.yearMin) / span : 0.5;
      var cold = [70, 130, 180];
      var warm = [214, 149, 60];
      var mixed = cold.map(function (channel, index) {
        return Math.round(channel + (warm[index] - channel) * ratio);
      });
      return "rgb(" + mixed.join(",") + ")";
    }
    // One neutral fill for everything else, lifted off the background just enough
    // to read: the graph's shape is the information, not a palette.
    return this.shade(theme.muted, theme.dark ? 0.22 : -0.08);
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
    // Coupling strength reads as opacity. The ceiling is low on purpose: a cluster
    // of strongly coupled papers has dozens of edges in a small area, and at any
    // higher opacity they merge into a solid mesh that hides the papers themselves.
    var alpha = link.type === "coupled"
      ? Math.min(0.3, 0.1 + Number(link.weight || 1) * 0.05)
      : 0.18;
    return this.withAlpha(base, alpha);
  },

  /**
   * Link width, in screen pixels — force-graph divides this by the zoom, so these
   * are the numbers that actually land on the display at any zoom level. Hairlines
   * are the point: coupling strength is carried by opacity, and a link thick enough
   * to notice individually turns a library into a transit map.
   */
  linkWidth(view, link) {
    var thickness = view.settings.linkThickness || 1;
    if (view.hoverId && this.touchesHover(view, link)) { return 2.2 * thickness; }
    return (link.type === "coupled"
      ? Math.min(1.8, 0.8 + Number(link.weight || 1) * 0.2)
      : 1) * thickness;
  },

  drawNode(view, node, ctx, scale) {
    var radius = this.drawRadius(view, node);
    var dim = this.dimmed(view, node.id);
    var color = this.nodeColor(view, node);

    ctx.globalAlpha = dim ? 0.25 : 1;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = color;
    ctx.fill();

    // A converted paper keeps a hairline ring — the one state worth spotting while
    // scanning the whole board. Everything else is said with the fill, so the ring
    // stays at 1.5 screen pixels rather than competing with the node itself.
    if (node.hasMarkdown) {
      ctx.lineWidth = 1.5 / scale;
      ctx.strokeStyle = this.withAlpha(view.theme.green, 0.9);
      ctx.stroke();
    }

    // Decluttering in screen pixels rather than simulation units: a label earns its
    // place once its node is big enough to read next to. Fading across a few pixels
    // rather than switching on at a threshold is most of why this reads as smooth —
    // a whole board of text appearing at once is what makes zooming feel abrupt.
    var important = node.id === view.centerId || node.id === view.selectedId ||
      node.id === view.hoverId || view.neighbours.has(node.id);
    var label = node.label || "";
    if (!label) { ctx.globalAlpha = 1; return; }
    var textAlpha = 1;
    if (!important) {
      if (node.degree < view.labelDegree) { ctx.globalAlpha = 1; return; }
      var pixels = radius * scale;
      var fade = view.settings.textFade;
      textAlpha = (pixels - fade) / this.LABEL_FADE_PX;
      if (textAlpha <= 0) { ctx.globalAlpha = 1; return; }
      if (textAlpha > 1) { textAlpha = 1; }
    }
    // Dividing by the zoom keeps text a constant size on screen at any zoom level.
    var fontSize = this.LABEL_PX / scale;
    ctx.globalAlpha = (dim ? 0.25 : 1) * textAlpha;
    ctx.font = fontSize + "px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = dim ? view.theme.muted : view.theme.fg;
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
