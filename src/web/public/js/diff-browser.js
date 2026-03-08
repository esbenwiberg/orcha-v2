/* Diff Browser — diff2html integration with branch picker */
(function () {
  'use strict';

  var sessionId = '';
  var currentBase = '';
  var currentPath = '';
  var viewMode = 'unified'; // 'unified' | 'split'
  var diff2htmlMod = null;
  var isLoadingLib = false;

  /** Lazy-load diff2html from esm.sh. */
  async function ensureDiff2Html() {
    if (diff2htmlMod) return;
    if (isLoadingLib) {
      while (isLoadingLib) await new Promise(function (r) { setTimeout(r, 50); });
      return;
    }
    isLoadingLib = true;
    try {
      diff2htmlMod = await import('https://esm.sh/diff2html@3');
    } finally {
      isLoadingLib = false;
    }
  }

  /** Render a unified diff string into the diff pane. */
  async function renderDiff(diffText) {
    await ensureDiff2Html();
    var container = document.getElementById('diff-content');
    var empty = document.getElementById('diff-empty');
    if (!container) return;

    if (!diffText || !diffText.trim()) {
      container.classList.add('hidden');
      if (empty) {
        empty.querySelector('p').textContent = 'No changes';
        empty.classList.remove('hidden');
      }
      return;
    }

    var outputFormat = viewMode === 'split' ? 'side-by-side' : 'line-by-line';
    var html = diff2htmlMod.html(diffText, {
      drawFileList: false,
      matching: 'lines',
      outputFormat: outputFormat,
    });

    container.innerHTML = html;
    container.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');
  }

  /** Fetch diff content for the current base + path. */
  async function loadDiff() {
    var url = '/api/sessions/' + sessionId + '/diff/content?base=' + encodeURIComponent(currentBase);
    if (currentPath) {
      url += '&path=' + encodeURIComponent(currentPath);
    }

    try {
      var resp = await fetch(url);
      var data = await resp.json();
      await renderDiff(data.diff || '');
    } catch (err) {
      console.warn('[diff-browser] load diff failed:', err);
      var container = document.getElementById('diff-content');
      if (container) {
        container.innerHTML = '<div class="diff-browser__error">Failed to load diff</div>';
        container.classList.remove('hidden');
      }
    }
  }

  /** Fetch and update commit + file count stats. */
  async function loadStats() {
    try {
      var resp = await fetch('/api/sessions/' + sessionId + '/diff/commits?base=' + encodeURIComponent(currentBase));
      var data = await resp.json();
      var commitEl = document.getElementById('diff-stat-commits');
      if (commitEl) commitEl.textContent = data.count + ' commit' + (data.count !== 1 ? 's' : '');
    } catch { /* ignore */ }
  }

  /** Update file count stat from the file list. */
  function updateFileCountStat() {
    var entries = document.querySelectorAll('.diff-file-entry:not(.diff-file-entry--all)');
    var el = document.getElementById('diff-stat-files');
    if (el) el.textContent = entries.length + ' file' + (entries.length !== 1 ? 's' : '');
  }

  // ── Public API ──

  window.__diffBrowserInit = function (sid, base) {
    sessionId = sid;
    currentBase = base;
    currentPath = '';
    viewMode = 'unified';

    // Load initial diff + stats
    loadDiff();
    loadStats();

    // Update file count after HTMX loads the file list
    document.body.addEventListener('htmx:afterSettle', function onSettle(e) {
      if (e.detail && e.detail.target && e.detail.target.id === 'diff-file-list') {
        updateFileCountStat();
        // Remove listener once overlay is gone
        if (!document.getElementById('diff-browser-overlay')) {
          document.body.removeEventListener('htmx:afterSettle', onSettle);
        }
      }
    });

    // Escape key: close dropdown first, then overlay
    function onKey(e) {
      if (e.key === 'Escape') {
        var dropdown = document.getElementById('diff-branch-dropdown');
        if (dropdown && !dropdown.classList.contains('hidden')) {
          dropdown.classList.add('hidden');
        } else {
          window.__diffBrowserClose();
          document.removeEventListener('keydown', onKey);
        }
      }
    }
    document.addEventListener('keydown', onKey);

    // Close dropdown when clicking outside picker
    var overlay = document.getElementById('diff-browser-overlay');
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (!e.target.closest('#diff-branch-picker')) {
          var dropdown = document.getElementById('diff-branch-dropdown');
          if (dropdown) dropdown.classList.add('hidden');
        }
      });
    }
  };

  window.__diffBrowserClose = function () {
    var overlay = document.getElementById('diff-browser-overlay');
    if (overlay) overlay.remove();
  };

  window.__diffSelectFile = function (btn) {
    var path = btn.getAttribute('data-path') || '';

    // Highlight active
    document.querySelectorAll('.diff-file-entry--active').forEach(function (el) {
      el.classList.remove('diff-file-entry--active');
    });
    btn.classList.add('diff-file-entry--active');

    currentPath = path;
    loadDiff();
  };

  window.__diffSelectBranch = function (btn) {
    var ref = btn.getAttribute('data-ref');
    if (!ref || ref === currentBase) {
      document.getElementById('diff-branch-dropdown').classList.add('hidden');
      return;
    }

    // Update active state
    document.querySelectorAll('.diff-branch-picker__item--active').forEach(function (el) {
      el.classList.remove('diff-branch-picker__item--active');
    });
    btn.classList.add('diff-branch-picker__item--active');

    // Update label
    var label = document.getElementById('diff-branch-label');
    if (label) label.textContent = ref;

    // Close dropdown
    document.getElementById('diff-branch-dropdown').classList.add('hidden');

    // Update base and reload everything
    currentBase = ref;
    currentPath = '';

    // Reload file list via HTMX
    var fileList = document.getElementById('diff-file-list');
    if (fileList && window.htmx) {
      window.htmx.ajax('GET', '/api/sessions/' + sessionId + '/diff/files?base=' + encodeURIComponent(ref), {
        target: '#diff-file-list',
        swap: 'innerHTML',
      });
    }

    // Reload diff + stats
    loadDiff();
    loadStats();
  };

  window.__diffSetViewMode = function (mode) {
    if (mode === viewMode) return;
    viewMode = mode;

    // Update toggle buttons
    document.querySelectorAll('.diff-view-toggle__btn').forEach(function (btn) {
      btn.classList.toggle('diff-view-toggle__btn--active', btn.getAttribute('data-mode') === mode);
    });

    // Re-render current diff
    loadDiff();
  };

  window.__diffBranchToggle = function () {
    var dropdown = document.getElementById('diff-branch-dropdown');
    var search = document.getElementById('diff-branch-search');
    if (!dropdown) return;

    var isHidden = dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden');
    if (isHidden && search) {
      search.value = '';
      search.dispatchEvent(new Event('input'));
      search.focus();
    }
  };

  // Branch search filter
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'diff-branch-search') {
      var q = e.target.value.toLowerCase();
      document.querySelectorAll('.diff-branch-picker__item').forEach(function (btn) {
        var ref = btn.getAttribute('data-ref').toLowerCase();
        btn.classList.toggle('hidden', !ref.includes(q));
      });
    }
  });
})();
