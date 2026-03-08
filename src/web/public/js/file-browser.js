/* File Browser — CodeMirror 6 integration with lazy directory tree */
(function () {
  'use strict';

  var CM_BASE = 'https://esm.sh';
  var sessionId = '';
  var currentPath = '';
  var editorView = null;
  var cmCore = null; // cached codemirror core module
  var cmTheme = null; // cached one-dark theme
  var isEditing = false;
  var isDirty = false;
  var isLoadingCM = false;

  // Language loaders — lazy-loaded by extension
  var LANG_MAP = {
    js: function () { return import(CM_BASE + '/@codemirror/lang-javascript@6'); },
    mjs: function () { return import(CM_BASE + '/@codemirror/lang-javascript@6'); },
    cjs: function () { return import(CM_BASE + '/@codemirror/lang-javascript@6'); },
    ts: function () { return import(CM_BASE + '/@codemirror/lang-javascript@6'); },
    mts: function () { return import(CM_BASE + '/@codemirror/lang-javascript@6'); },
    cts: function () { return import(CM_BASE + '/@codemirror/lang-javascript@6'); },
    jsx: function () { return import(CM_BASE + '/@codemirror/lang-javascript@6'); },
    tsx: function () { return import(CM_BASE + '/@codemirror/lang-javascript@6'); },
    py: function () { return import(CM_BASE + '/@codemirror/lang-python@6'); },
    html: function () { return import(CM_BASE + '/@codemirror/lang-html@6'); },
    htm: function () { return import(CM_BASE + '/@codemirror/lang-html@6'); },
    css: function () { return import(CM_BASE + '/@codemirror/lang-css@6'); },
    scss: function () { return import(CM_BASE + '/@codemirror/lang-css@6'); },
    json: function () { return import(CM_BASE + '/@codemirror/lang-json@6'); },
    md: function () { return import(CM_BASE + '/@codemirror/lang-markdown@6'); },
    mdx: function () { return import(CM_BASE + '/@codemirror/lang-markdown@6'); },
    sql: function () { return import(CM_BASE + '/@codemirror/lang-sql@6'); },
    xml: function () { return import(CM_BASE + '/@codemirror/lang-xml@6'); },
    svg: function () { return import(CM_BASE + '/@codemirror/lang-xml@6'); },
    yaml: function () { return import(CM_BASE + '/@codemirror/lang-yaml@6'); },
    yml: function () { return import(CM_BASE + '/@codemirror/lang-yaml@6'); },
    rs: function () { return import(CM_BASE + '/@codemirror/lang-rust@6'); },
    go: function () { return import(CM_BASE + '/@codemirror/lang-go@6'); },
    java: function () { return import(CM_BASE + '/@codemirror/lang-java@6'); },
    php: function () { return import(CM_BASE + '/@codemirror/lang-php@6'); },
    cpp: function () { return import(CM_BASE + '/@codemirror/lang-cpp@6'); },
    cc: function () { return import(CM_BASE + '/@codemirror/lang-cpp@6'); },
    c: function () { return import(CM_BASE + '/@codemirror/lang-cpp@6'); },
    h: function () { return import(CM_BASE + '/@codemirror/lang-cpp@6'); },
    hpp: function () { return import(CM_BASE + '/@codemirror/lang-cpp@6'); },
    sh: function () { return import(CM_BASE + '/@codemirror/lang-javascript@6'); },
    bash: function () { return import(CM_BASE + '/@codemirror/lang-javascript@6'); },
  };

  var langCache = {};

  /** Load CodeMirror core + theme (once). */
  async function ensureCM() {
    if (cmCore && cmTheme) return;
    if (isLoadingCM) {
      // Wait for in-flight load
      while (isLoadingCM) await new Promise(function (r) { setTimeout(r, 50); });
      return;
    }
    isLoadingCM = true;
    try {
      var results = await Promise.all([
        import(CM_BASE + '/codemirror@6'),
        import(CM_BASE + '/@codemirror/theme-one-dark@6'),
        import(CM_BASE + '/@codemirror/view@6'),
        import(CM_BASE + '/@codemirror/state@6'),
      ]);
      cmCore = { cm: results[0], view: results[2], state: results[3] };
      cmTheme = results[1];
    } finally {
      isLoadingCM = false;
    }
  }

  /** Load language extension by file extension. */
  async function getLanguageExtension(ext) {
    ext = ext.replace(/^\./, '').toLowerCase();
    if (langCache[ext]) return langCache[ext];
    var loader = LANG_MAP[ext];
    if (!loader) return null;
    try {
      var mod = await loader();
      // Most lang packages export a function named after the language
      var fn = mod.javascript || mod.typescript || mod.python || mod.html ||
               mod.css || mod.json || mod.markdown || mod.sql || mod.xml ||
               mod.yaml || mod.rust || mod.go || mod.java || mod.php || mod.cpp;
      if (fn) {
        var langExt = fn();
        langCache[ext] = langExt;
        return langExt;
      }
    } catch (e) {
      console.warn('[file-browser] lang load failed for', ext, e);
    }
    return null;
  }

  /** Create or reconfigure the CodeMirror editor. */
  async function setEditorContent(content, ext, readOnly) {
    var container = document.getElementById('fb-editor-container');
    if (!container) return;
    container.classList.remove('hidden');
    document.getElementById('fb-editor-empty').classList.add('hidden');
    document.getElementById('fb-editor-message').classList.add('hidden');

    await ensureCM();

    var extensions = [cmCore.cm.basicSetup, cmTheme.oneDark];
    var langExt = await getLanguageExtension(ext);
    if (langExt) extensions.push(langExt);

    if (readOnly) {
      extensions.push(cmCore.state.EditorState.readOnly.of(true));
      extensions.push(cmCore.view.EditorView.editable.of(false));
    }

    // Track changes for dirty indicator
    extensions.push(cmCore.view.EditorView.updateListener.of(function (update) {
      if (update.docChanged && isEditing) {
        isDirty = true;
        updateSaveBtn();
      }
    }));

    // Ctrl+S / Cmd+S save shortcut
    extensions.push(cmCore.view.keymap.of([{
      key: 'Mod-s',
      run: function () {
        if (isEditing && isDirty) window.__fbSave();
        return true;
      }
    }]));

    if (editorView) {
      editorView.destroy();
    }

    editorView = new cmCore.view.EditorView({
      doc: content,
      extensions: extensions,
      parent: container,
    });
  }

  function showMessage(msg) {
    var el = document.getElementById('fb-editor-message');
    if (el) {
      el.textContent = msg;
      el.classList.remove('hidden');
    }
    document.getElementById('fb-editor-container').classList.add('hidden');
    document.getElementById('fb-editor-empty').classList.add('hidden');
  }

  function updateBreadcrumb(path) {
    var el = document.getElementById('fb-path');
    if (el) el.textContent = path || 'Select a file...';
  }

  function updateSaveBtn() {
    var saveBtn = document.getElementById('fb-save-btn');
    if (saveBtn && isEditing) {
      saveBtn.textContent = isDirty ? 'Save *' : 'Save';
    }
  }

  function showToast(msg, type) {
    var container = document.getElementById('toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast--' + (type || 'success');
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(function () {
      toast.classList.add('is-exiting');
      setTimeout(function () { toast.remove(); }, 300);
    }, 2500);
  }

  // ── Public API ──

  window.__fileBrowserInit = function (sid) {
    sessionId = sid;
    currentPath = '';
    editorView = null;
    isEditing = false;
    isDirty = false;

    // Escape to close
    function onKey(e) {
      if (e.key === 'Escape') {
        window.__fileBrowserClose();
        document.removeEventListener('keydown', onKey);
      }
    }
    document.addEventListener('keydown', onKey);
  };

  window.__fileBrowserClose = function () {
    var overlay = document.getElementById('file-browser-overlay');
    if (overlay) overlay.remove();
    if (editorView) {
      editorView.destroy();
      editorView = null;
    }
  };

  window.__fbToggleFolder = function (btn) {
    var folder = btn.closest('.file-tree__folder');
    if (!folder) return;
    var children = folder.querySelector('.file-tree__children');
    if (!children) return;

    var isOpen = folder.classList.contains('is-open');
    if (isOpen) {
      folder.classList.remove('is-open');
      children.classList.add('hidden');
    } else {
      folder.classList.add('is-open');
      children.classList.remove('hidden');
      // Lazy-load if empty
      if (!children.dataset.loaded) {
        var path = btn.dataset.path;
        var sid = btn.dataset.session;
        var depth = parseInt(btn.dataset.depth, 10) + 1;
        children.innerHTML = '<div class="file-tree__loading" style="padding-left:' + (8 + depth * 16) + 'px">Loading...</div>';
        fetch('/api/sessions/' + sid + '/files?path=' + encodeURIComponent(path) + '&depth=' + depth)
          .then(function (r) { return r.text(); })
          .then(function (html) {
            children.innerHTML = html;
            children.dataset.loaded = '1';
            // Re-process HTMX if present
            if (window.htmx) window.htmx.process(children);
          })
          .catch(function () {
            children.innerHTML = '<div class="file-tree__loading" style="padding-left:' + (8 + depth * 16) + 'px">Error loading</div>';
          });
      }
    }
  };

  window.__fbOpenFile = function (btn) {
    var path = btn.dataset.path;
    var sid = btn.dataset.session;
    if (!path || !sid) return;

    // Highlight active
    document.querySelectorAll('.file-tree__entry--active').forEach(function (el) {
      el.classList.remove('file-tree__entry--active');
    });
    btn.classList.add('file-tree__entry--active');

    // Reset edit state
    isEditing = false;
    isDirty = false;
    var editToggle = document.getElementById('fb-edit-toggle');
    var saveBtn = document.getElementById('fb-save-btn');
    if (editToggle) { editToggle.classList.remove('hidden'); editToggle.textContent = 'Edit'; }
    if (saveBtn) saveBtn.classList.add('hidden');

    currentPath = path;
    updateBreadcrumb(path);

    // On mobile, switch to editor pane
    var body = document.querySelector('.file-browser__body');
    if (body && window.innerWidth <= 768) {
      body.classList.add('show-editor');
      document.getElementById('fb-back-btn').classList.remove('hidden');
    }

    // Fetch file content
    fetch('/api/sessions/' + sid + '/file-content?path=' + encodeURIComponent(path))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          showMessage(data.error);
          return;
        }
        if (data.binary) {
          showMessage('Binary file \u2014 cannot display (' + formatSize(data.size) + ')');
          if (editToggle) editToggle.classList.add('hidden');
          return;
        }
        var ext = path.split('.').pop() || '';
        setEditorContent(data.content, ext, true);
      })
      .catch(function (err) {
        showMessage('Failed to load file: ' + err.message);
      });
  };

  window.__fbToggleEdit = function () {
    if (!currentPath || !editorView) return;
    var editToggle = document.getElementById('fb-edit-toggle');
    var saveBtn = document.getElementById('fb-save-btn');

    if (isEditing) {
      // Switch to read-only — reload the file
      isEditing = false;
      isDirty = false;
      if (editToggle) editToggle.textContent = 'Edit';
      if (saveBtn) saveBtn.classList.add('hidden');
      // Reload
      fetch('/api/sessions/' + sessionId + '/file-content?path=' + encodeURIComponent(currentPath))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.content !== undefined) {
            var ext = currentPath.split('.').pop() || '';
            setEditorContent(data.content, ext, true);
          }
        });
    } else {
      // Switch to edit mode — recreate with readOnly=false
      isEditing = true;
      isDirty = false;
      if (editToggle) editToggle.textContent = 'View';
      if (saveBtn) { saveBtn.classList.remove('hidden'); saveBtn.textContent = 'Save'; }
      var content = editorView.state.doc.toString();
      var ext = currentPath.split('.').pop() || '';
      setEditorContent(content, ext, false);
    }
  };

  window.__fbSave = function () {
    if (!currentPath || !editorView || !isEditing) return;
    var content = editorView.state.doc.toString();

    fetch('/api/sessions/' + sessionId + '/file-content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentPath, content: content }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          isDirty = false;
          updateSaveBtn();
          showToast('Saved ' + currentPath, 'success');
        } else {
          showToast('Save failed: ' + (data.error || 'Unknown error'), 'error');
        }
      })
      .catch(function (err) {
        showToast('Save failed: ' + err.message, 'error');
      });
  };

  window.__fbBackToTree = function () {
    var body = document.querySelector('.file-browser__body');
    if (body) body.classList.remove('show-editor');
    document.getElementById('fb-back-btn').classList.add('hidden');
  };

  function formatSize(bytes) {
    if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
  }
})();
