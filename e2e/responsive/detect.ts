/**
 * Rendered responsive-break detector for the pokewin-admin audit harness.
 *
 * `detectOffenders` is serialized and run INSIDE the page via
 * `page.evaluate`, so it must be fully self-contained: no imports, no
 * closures over Node-side values, only the DOM + the single `opts`
 * argument Playwright passes in. The shapes below are shared with the
 * Node side purely as TypeScript types (erased at runtime).
 *
 * Philosophy — measure pixels, don't read classes. Two prior class-reading
 * audits missed the /users/[id] overlap; this looks at real
 * getBoundingClientRect geometry after layout.
 *
 * GATING offenders (a clean page MUST have zero):
 *   - horizontal-overflow : documentElement scrolls wider than the viewport
 *   - element-overflow-right : a visible, in-flow element's right edge
 *                              crosses the viewport's right edge
 *   - sibling-overlap : two in-flow (non-absolute) sibling elements paint
 *                       on top of each other (the exact KPI-tiles-over-
 *                       helper-text failure on /users/[id])
 *
 * WARN-ONLY (reported, never gates — too noisy to fail a build on):
 *   - one-word-per-line : a text block collapsed so narrow that words wrap
 *                         one per line (the helper <p> symptom)
 *   - small-tap-target : an interactive control smaller than 44px
 */

export type OffenderKind =
  | "horizontal-overflow"
  | "element-overflow-right"
  | "child-overflows-container"
  | "crushed-flex-item"
  | "sibling-overlap"
  | "one-word-per-line"
  | "small-tap-target";

export type Severity = "gating" | "warn";

export type Offender = {
  kind: OffenderKind;
  severity: Severity;
  /** Human-readable description for the report. */
  detail: string;
  /** Stable-ish selector for the offending element (best effort). */
  selector: string;
  /** Short visible-text snippet to help a human locate it. */
  text: string;
  /** Bounding box of the offending element (viewport coords). */
  rect: { x: number; y: number; width: number; height: number };
  /** For sibling-overlap: the other element's box + selector. */
  other?: {
    selector: string;
    text: string;
    rect: { x: number; y: number; width: number; height: number };
  };
  /** Area of the offence (overlap area, or overshoot px). Used to rank "worst". */
  score: number;
};

export type DetectResult = {
  innerWidth: number;
  innerHeight: number;
  scrollWidth: number;
  offenders: Offender[];
  gatingCount: number;
  warnCount: number;
};

export type DetectOptions = {
  /** Sub-pixel slack for overflow comparisons. */
  tolerance: number;
  /** Minimum overlap area (px²) to count a sibling-overlap (kills border touches). */
  minOverlapArea: number;
  /** Minimum element area (px²) to be considered for overlap (kills hairlines). */
  minElementArea: number;
  /** Tap-target minimum (px) for the warn-only check. */
  tapTargetMin: number;
};

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  tolerance: 2,
  minOverlapArea: 120,
  minElementArea: 100,
  tapTargetMin: 44,
};

/**
 * The function injected into the page. Declared as a normal exported
 * function (typed) and passed BY REFERENCE to page.evaluate — Playwright
 * serializes its source, so it must not reference anything outside its
 * own body and the `opts` arg.
 */
export function detectOffenders(opts: DetectOptions): DetectResult {
  const innerWidth = window.innerWidth;
  const innerHeight = window.innerHeight;
  const docEl = document.documentElement;
  const scrollWidth = docEl.scrollWidth;

  const offenders: Offender[] = [];

  // ---- helpers (kept inside so they serialize with the function) --------

  function isVisible(el: Element): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity || "1") === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return true;
  }

  // SVG-internal geometry (paths, groups, shapes inside an <svg>) is the
  // illustration's own coordinate space — two <path>s in one icon routinely
  // share pixels by design. Never treat that as a layout offence. We DO
  // still consider the <svg> element itself (it participates in page
  // layout), just not its descendants.
  function isSvgInternal(el: Element): boolean {
    if (el.tagName.toLowerCase() === "svg") return false;
    return el.closest("svg") !== null;
  }

  // Decorative / non-layout elements we deliberately ignore for the
  // overflow + overlap geometry: absolute/fixed glows + overlays, the
  // pointer-events:none decorative washes, aria-hidden chrome, and
  // SVG-internal shapes.
  function isDecorativeOrOutOfFlow(el: Element): boolean {
    if (isSvgInternal(el)) return true;
    const style = window.getComputedStyle(el);
    const pos = style.position;
    if (pos === "absolute" || pos === "fixed") return true;
    if (style.pointerEvents === "none") return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    return false;
  }

  // Sticky bars (the user-detail tab bar is `sticky top-0`) legitimately
  // sit over scrolled content — never count them as overlap offenders.
  function isStickyChain(el: Element | null): boolean {
    let cur: Element | null = el;
    let hops = 0;
    while (cur && hops < 4) {
      const p = window.getComputedStyle(cur).position;
      if (p === "sticky" || p === "fixed") return true;
      cur = cur.parentElement;
      hops++;
    }
    return false;
  }

  function selectorFor(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const id = (el as HTMLElement).id;
    if (id) return `${tag}#${id}`;
    const cls = (el.getAttribute("class") || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join(".");
    let base = cls ? `${tag}.${cls}` : tag;
    // Add nth-of-type within parent for a touch more stability.
    const parent = el.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === el.tagName,
      );
      if (sameTag.length > 1) {
        const idx = sameTag.indexOf(el) + 1;
        base += `:nth-of-type(${idx})`;
      }
    }
    return base;
  }

  function textOf(el: Element): string {
    const t = (el.textContent || "").trim().replace(/\s+/g, " ");
    return t.length > 60 ? t.slice(0, 57) + "…" : t;
  }

  function rectObj(r: DOMRect) {
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }

  // ---- (a) horizontal overflow on the document --------------------------
  if (scrollWidth > innerWidth + opts.tolerance) {
    offenders.push({
      kind: "horizontal-overflow",
      severity: "gating",
      detail: `document scrollWidth ${scrollWidth} exceeds innerWidth ${innerWidth} by ${scrollWidth - innerWidth}px`,
      selector: "html",
      text: "",
      rect: { x: 0, y: 0, width: scrollWidth, height: Math.round(docEl.scrollHeight) },
      score: scrollWidth - innerWidth,
    });
  }

  // ---- (b) visible in-flow element overshoots the viewport right edge ----
  // Walk all elements once; collect candidates for (b), (c), (d), (e).
  const all = Array.from(document.body.querySelectorAll<HTMLElement>("*"));

  for (const el of all) {
    if (!isVisible(el)) continue;
    if (isDecorativeOrOutOfFlow(el)) continue;
    if (isStickyChain(el)) continue;
    const r = el.getBoundingClientRect();

    // (b) right edge past the viewport. Require a real overshoot beyond
    // tolerance and ignore elements that start off-screen entirely (those
    // are usually intentional carousels / horizontal-scroll regions whose
    // PARENT clips them — the parent would be the real offender and is
    // caught by the overflow check if it actually leaks).
    if (
      r.right > innerWidth + opts.tolerance &&
      r.left < innerWidth &&
      r.width <= innerWidth + opts.tolerance
    ) {
      // Skip if an ancestor clips overflow (the element is visually
      // contained even though its own box pokes out — e.g. an overflow-x
      // -auto scroller's wide child).
      let clipped = false;
      let anc = el.parentElement;
      let hops = 0;
      while (anc && hops < 8) {
        const os = window.getComputedStyle(anc);
        if (
          os.overflowX === "auto" ||
          os.overflowX === "hidden" ||
          os.overflowX === "scroll" ||
          os.overflow === "auto" ||
          os.overflow === "hidden" ||
          os.overflow === "scroll"
        ) {
          const ar = anc.getBoundingClientRect();
          if (ar.right <= innerWidth + opts.tolerance) {
            clipped = true;
            break;
          }
        }
        anc = anc.parentElement;
        hops++;
      }
      if (!clipped) {
        offenders.push({
          kind: "element-overflow-right",
          severity: "gating",
          detail: `element right edge ${Math.round(r.right)} exceeds innerWidth ${innerWidth}`,
          selector: selectorFor(el),
          text: textOf(el),
          rect: rectObj(r),
          score: r.right - innerWidth,
        });
      }
    }

    // (b2) CHILD OVERFLOWS ITS PARENT — a non-shrinking flex/grid child that
    // demands more width than its parent has and refuses to shrink (the
    // `shrink-0` smoking gun). This is the /users/[id] failure mode: the
    // 8-tile KPI grid is `shrink-0`, so at lg+ it blows out to ~1533px
    // inside a ~900px hero, spilling far past the hero's right edge and
    // crushing its sibling identity column. The plain viewport check (b)
    // misses it because the child is WIDER than the viewport (it was
    // excluded there as a presumed intentional scroller). Here we instead
    // compare against the PARENT's right edge and require the parent itself
    // to NOT be a scroll container (a real scroller legitimately holds an
    // over-wide child; a normal flex/grid parent does not).
    {
      const parent = el.parentElement;
      if (parent && parent !== document.body) {
        const ps = window.getComputedStyle(parent);
        const parentScrolls =
          ps.overflowX === "auto" ||
          ps.overflowX === "scroll" ||
          ps.overflow === "auto" ||
          ps.overflow === "scroll";
        const parentIsFlexOrGrid =
          ps.display === "flex" ||
          ps.display === "inline-flex" ||
          ps.display === "grid" ||
          ps.display === "inline-grid";
        if (!parentScrolls && parentIsFlexOrGrid) {
          const pr = parent.getBoundingClientRect();
          // Overflow past the parent's right edge by a meaningful margin.
          const overshoot = r.right - pr.right;
          if (overshoot > Math.max(opts.tolerance, 4) && r.width > 40) {
            offenders.push({
              kind: "child-overflows-container",
              severity: "gating",
              detail: `flex/grid child (${Math.round(r.width)}px wide) overflows its parent by ${Math.round(overshoot)}px — likely a non-shrinking (shrink-0) item`,
              selector: selectorFor(el),
              text: textOf(el),
              rect: rectObj(r),
              score: overshoot,
            });
          }
        }
      }
    }

    // (b3) CRUSHED FLEX ITEM — an in-flow flex child squeezed to ~0 width
    // while it still contains real content (so its text/children are forced
    // into a 1-char-per-line sliver or clipped). The mirror image of (b2):
    // when the KPI grid refuses to shrink, its sibling identity column is
    // crushed to width 0. Flag a flex child whose width collapsed below a
    // few px but whose own content is non-trivially tall (it HAS content
    // that should occupy width).
    {
      const parent = el.parentElement;
      if (parent && parent !== document.body) {
        const ps = window.getComputedStyle(parent);
        const parentIsFlex =
          ps.display === "flex" || ps.display === "inline-flex";
        if (parentIsFlex && r.width <= 2 && el.childElementCount > 0) {
          // Does it have content that wants width? (a descendant with text)
          const hasContentfulChild = !!Array.from(
            el.querySelectorAll("*"),
          ).find((c) => (c.textContent || "").trim().length > 0);
          // Tall + zero-width = crushed (its content is stacked into a
          // sliver). Guard on a minimum height so genuinely-empty 0×0
          // spacers don't trip it.
          if (hasContentfulChild && r.height >= 24) {
            offenders.push({
              kind: "crushed-flex-item",
              severity: "gating",
              detail: `flex child crushed to ${Math.round(r.width)}px wide but ${Math.round(r.height)}px tall — its content is squeezed into a sliver (a non-shrinking sibling is starving it)`,
              selector: selectorFor(el),
              text: textOf(el),
              rect: rectObj(r),
              score: r.height,
            });
          }
        }
      }
    }

    // (e) WARN: interactive control smaller than the tap-target minimum.
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const interactive =
      tag === "button" ||
      tag === "a" ||
      (tag === "input" &&
        !["hidden", "checkbox", "radio"].includes(
          (el as HTMLInputElement).type,
        )) ||
      role === "button" ||
      role === "link" ||
      role === "tab";
    if (interactive) {
      // Only flag if it has visible text/icon content (skip 0-size wrappers
      // and icon-only controls are still flagged since they're tappable).
      if (
        (r.height < opts.tapTargetMin || r.width < opts.tapTargetMin) &&
        r.width > 0 &&
        r.height > 0
      ) {
        offenders.push({
          kind: "small-tap-target",
          severity: "warn",
          detail: `tap target ${Math.round(r.width)}×${Math.round(r.height)} < ${opts.tapTargetMin}px`,
          selector: selectorFor(el),
          text: textOf(el),
          rect: rectObj(r),
          score: opts.tapTargetMin - Math.min(r.width, r.height),
        });
      }
    }

    // (d) WARN: one-word-per-line text collapse. A leaf-ish text element
    // that is much taller than one line for its character count, AND whose
    // content scrolls wider than its box (content can't fit on a line).
    const hasOwnText =
      el.childElementCount === 0 && (el.textContent || "").trim().length > 0;
    if (hasOwnText) {
      const txt = (el.textContent || "").trim();
      const words = txt.split(/\s+/).filter(Boolean);
      if (words.length >= 3) {
        const style = window.getComputedStyle(el);
        const lineHeightRaw = parseFloat(style.lineHeight);
        const fontSize = parseFloat(style.fontSize) || 14;
        const lineHeight =
          isNaN(lineHeightRaw) || lineHeightRaw <= 0
            ? fontSize * 1.3
            : lineHeightRaw;
        const lines = Math.round(r.height / lineHeight);
        // One-word-per-line ⇒ lines ≈ word count and the box is very
        // narrow. Require the line count to be at least 80% of the word
        // count (so 5 words wrapping into ~5 lines) and a narrow box.
        if (
          lines >= 3 &&
          lines >= Math.ceil(words.length * 0.8) &&
          r.width < fontSize * 8
        ) {
          offenders.push({
            kind: "one-word-per-line",
            severity: "warn",
            detail: `text wraps to ~${lines} lines for ${words.length} words in a ${Math.round(r.width)}px-wide box`,
            selector: selectorFor(el),
            text: textOf(el),
            rect: rectObj(r),
            score: lines,
          });
        }
      }
    }
  }

  // ---- (c) in-flow sibling bounding-box intersection --------------------
  // The exact detector for the /users/[id] break: the KPI grid and the
  // helper <p> are siblings in the stacked (flex-col) hero and end up
  // painting on top of each other. We compare DIRECT siblings (same
  // parent) that are both in-flow + visible + non-trivial, and flag a real
  // (area > minOverlapArea) intersection. Comparing only direct siblings
  // (not arbitrary element pairs) is what keeps this from drowning in
  // false positives from normal nested/stacked layouts.
  const parents = new Set<Element>();
  for (const el of all) {
    if (el.parentElement) parents.add(el.parentElement);
  }

  function eligibleForOverlap(el: Element): boolean {
    if (!isVisible(el)) return false;
    if (isDecorativeOrOutOfFlow(el)) return false;
    if (isStickyChain(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < opts.minElementArea) return false;
    return true;
  }

  const seenPairs = new Set<string>();
  for (const parent of parents) {
    const kids = Array.from(parent.children).filter(eligibleForOverlap);
    if (kids.length < 2) continue;
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i];
        const b = kids[j];
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const ix = Math.max(ra.left, rb.left);
        const iy = Math.max(ra.top, rb.top);
        const ax = Math.min(ra.right, rb.right);
        const ay = Math.min(ra.bottom, rb.bottom);
        const iw = ax - ix;
        const ih = ay - iy;
        if (iw <= 0 || ih <= 0) continue;
        const overlapArea = iw * ih;
        if (overlapArea < opts.minOverlapArea) continue;
        // Ignore the degenerate case where one fully contains the other
        // (that's normal nesting expressed as siblings only rarely, but a
        // wrapper that wraps another sibling is not a "paint collision").
        const aContainsB =
          ra.left <= rb.left + 1 &&
          ra.top <= rb.top + 1 &&
          ra.right >= rb.right - 1 &&
          ra.bottom >= rb.bottom - 1;
        const bContainsA =
          rb.left <= ra.left + 1 &&
          rb.top <= ra.top + 1 &&
          rb.right >= ra.right - 1 &&
          rb.bottom >= ra.bottom - 1;
        if (aContainsB || bContainsA) continue;

        const key = `${i}-${j}-${Math.round(ix)}-${Math.round(iy)}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);

        offenders.push({
          kind: "sibling-overlap",
          severity: "gating",
          detail: `in-flow siblings overlap by ${Math.round(iw)}×${Math.round(ih)} (${Math.round(overlapArea)}px²)`,
          selector: selectorFor(a),
          text: textOf(a),
          rect: rectObj(ra),
          other: {
            selector: selectorFor(b),
            text: textOf(b),
            rect: rectObj(rb),
          },
          score: overlapArea,
        });
      }
    }
  }

  const gatingCount = offenders.filter((o) => o.severity === "gating").length;
  const warnCount = offenders.filter((o) => o.severity === "warn").length;

  // Worst-first so the screenshot box targets the biggest offence.
  offenders.sort((p, q) => {
    if (p.severity !== q.severity) return p.severity === "gating" ? -1 : 1;
    return q.score - p.score;
  });

  return {
    innerWidth,
    innerHeight,
    scrollWidth,
    offenders,
    gatingCount,
    warnCount,
  };
}
