/* ============================================================================
   Apex — keyset pagination (Group 6.1)
   2026-09-11.v25.2

   WHY KEYSET AND NOT range()
   ---------------------------------------------------------------------------
   Offset pagination asks for "rows 25–49". If a new invoice is created while
   the customer is reading page 1, every row shifts down one and row 25 becomes
   what row 24 was — so page 2 repeats a row the customer already saw, and an
   older row can be skipped entirely. On a financial history that is not a
   cosmetic bug.

   Keyset pagination asks for "rows after this exact one" instead, so an
   insertion at the top of the list cannot move the boundary.

   THE PREDICATE
   ---------------------------------------------------------------------------
   Ordering is (sortColumn DESC, id DESC) — a total order, because id is unique.
   The next page is everything strictly after the last row of the previous page:

       sortColumn < cursor.sort
       OR (sortColumn = cursor.sort AND id < cursor.id)

   Expressed through PostgREST as:

       or=(sort.lt."<value>",and(sort.eq."<value>",id.lt."<id>"))

   Postgres does the comparison. Nothing here compares timestamps or UUIDs in
   JavaScript, which would get the collation wrong.

   LOOK-AHEAD
   ---------------------------------------------------------------------------
   Each request asks for pageSize + 1 rows. If the extra row comes back there is
   another page; it is dropped, not rendered, and the cursor is taken from the
   last DISPLAYED row. That avoids a COUNT query on every Load More.
   ============================================================================ */
(function () {
  "use strict";

  var PAGE_SIZE = 25;   // one screen of cards on a laptop; ~3 scrolls on a phone

  /**
   * Values are double-quoted in the filter string. PostgREST treats `.` as the
   * column.operator.value separator and `,` as a condition separator, and an
   * ISO timestamp contains dots. Quoting removes the ambiguity.
   * A literal double quote or backslash in a value would break out of the
   * quoting, so those are rejected rather than escaped — no id or timestamp
   * this app generates contains them, and guessing is worse than refusing.
   */
  function quote(v) {
    var s = String(v);
    if (s.indexOf('"') !== -1 || s.indexOf("\\") !== -1) {
      throw new Error("ApexPage: unsafe cursor value");
    }
    return '"' + s + '"';
  }

  function cursorFilter(sortCol, cursor) {
    return sortCol + ".lt." + quote(cursor.sort) +
           ",and(" + sortCol + ".eq." + quote(cursor.sort) +
           "," + "id.lt." + quote(cursor.id) + ")";
  }

  /** Fresh state for one list. */
  function create(opts) {
    return {
      table: opts.table,
      sortCol: opts.sortCol || "created_at",
      pageSize: opts.pageSize || PAGE_SIZE,
      select: opts.select || "*",
      applyFilters: opts.applyFilters || function (q) { return q; },
      items: [],
      seen: Object.create(null),   // defensive dedupe by primary id
      cursor: null,
      hasMore: false,
      loadingMore: false,
      initialLoading: false,
      error: null,
    };
  }

  function reset(st) {
    st.items = [];
    st.seen = Object.create(null);
    st.cursor = null;
    st.hasMore = false;
    st.error = null;
    st.loadingMore = false;
    return st;
  }

  /**
   * Fetch the next page and append. Returns { added, hasMore, error }.
   * On failure the already-loaded rows and the cursor are left untouched, so a
   * retry resumes from exactly where it stopped rather than reloading.
   */
  async function loadPage(sb, st) {
    if (st.loadingMore) return { added: 0, hasMore: st.hasMore, error: null };
    st.loadingMore = true;
    st.error = null;
    try {
      var q = sb.from(st.table).select(st.select);
      q = st.applyFilters(q);
      if (st.cursor) q = q.or(cursorFilter(st.sortCol, st.cursor));
      q = q.order(st.sortCol, { ascending: false })
           .order("id", { ascending: false })
           .limit(st.pageSize + 1);            // look-ahead row

      var res = await q;
      if (res.error) { st.error = res.error; return { added: 0, hasMore: st.hasMore, error: res.error }; }

      var rows = res.data || [];
      st.hasMore = rows.length > st.pageSize;
      var page = st.hasMore ? rows.slice(0, st.pageSize) : rows;

      var added = 0;
      for (var i = 0; i < page.length; i++) {
        var r = page[i];
        if (st.seen[r.id]) continue;           // a row cannot appear twice
        st.seen[r.id] = true;
        st.items.push(r);
        added++;
      }
      // Cursor comes from the last DISPLAYED row, never the look-ahead row.
      if (page.length) {
        var last = page[page.length - 1];
        st.cursor = { sort: last[st.sortCol], id: last.id };
      }
      return { added: added, hasMore: st.hasMore, error: null, page: page };
    } finally {
      st.loadingMore = false;
    }
  }

  /**
   * Load More button markup. A real <button>, so it is keyboard reachable and
   * activates on Enter and Space with no extra handling.
   */
  /* handlerName is retained for call-site clarity but is NO LONGER
     interpolated into markup — the button carries data-action instead, so
     nothing here can become an inline handler. */
  function moreButtonHtml(st, handlerName, label) {
    // When the list is exhausted there is no button, but the live region must
    // still exist — otherwise handleMore() has nothing to write "All records
    // loaded." into after the final render, and the announcement silently never
    // happens. The bare span is invisible until it has text (.apex-more-status
    // is display:none while :empty), so it adds no layout.
    if (!st.hasMore) {
      return '<span class="apex-more-status" role="status" aria-live="polite"></span>';
    }
    return '<div class="apex-more-wrap">' +
      '<button type="button" class="btn-secondary apex-more" ' +
      'data-action="load-more" data-list="' + st.table + '">' +
      (label || "Load older") + '</button>' +
      '<span class="apex-more-status" role="status" aria-live="polite"></span>' +
      '</div>';
  }

  /**
   * Runs a Load More click: disables the button, announces progress, re-enables
   * on failure so the customer can retry, and never clears rows already shown.
   * Focus is left on the button so the keyboard position is not lost.
   */
  /**
   * Runs a Load More click.
   *
   * This function does NOT fetch. It hands off to `loadFn`, which performs
   * exactly one page request and then renders. An earlier version called
   * loadPage() here AND passed a callback that also called loadPage(), so a
   * single click fetched two pages — 50 rows instead of 25, and two requests.
   * Fetching lives in exactly one place now.
   *
   * `loadFn` is awaited, so the replacement DOM exists before focus is moved.
   * It signals failure by resolving to an object with a truthy `error`.
   */
  async function handleMore(wrapEl, loadFn) {
    if (!wrapEl) return { error: null };
    var btn = wrapEl.querySelector(".apex-more");
    var status = wrapEl.querySelector(".apex-more-status");
    if (!btn || btn.disabled) return { error: null };
    var restoreFocus = document.activeElement === btn;

    btn.disabled = true;
    var originalLabel = btn.textContent;
    btn.textContent = "Loading…";
    if (status) status.textContent = "Loading older records.";

    var out;
    try {
      out = await loadFn();                 // one page request, then render
    } catch (e) {
      out = { error: e };
    }

    if (out && out.error) {
      // The rows already on screen are untouched; only the button resets.
      btn.disabled = false;
      btn.textContent = originalLabel;
      if (status) status.textContent = "Could not load more. Please try again.";
      return out;
    }

    // Rendering has completed, so the new button (if any) exists to focus.
    if (restoreFocus) {
      var next = wrapEl.querySelector(".apex-more");
      if (next) { try { next.focus(); } catch (e) {} }
      else {
        var live = wrapEl.querySelector(".apex-more-status");
        if (live) live.textContent = "All records loaded.";
      }
    }
    return out || { error: null };
  }

  window.ApexPage = {
    PAGE_SIZE: PAGE_SIZE,
    create: create,
    reset: reset,
    loadPage: loadPage,
    moreButtonHtml: moreButtonHtml,
    handleMore: handleMore,
    _cursorFilter: cursorFilter,
    _quote: quote,
  };
})();
