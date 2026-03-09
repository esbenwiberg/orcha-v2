/**
 * Kanban board SSE integration.
 *
 * Listens for task status events from the SSE stream and refreshes
 * the board when tasks move between statuses.
 */

(function () {
  'use strict';

  var STATUS_TO_COLUMN = {
    draft: 'inbox',
    investigating: 'investigating',
    rejected: 'review',
    enriching: 'pipeline',
    queued: 'pipeline',
    executing: 'pipeline',
    done: 'done',
    failed: 'failed',
    cancelled: 'failed',
  };

  var eventSource = null;
  var reconnectTimer = null;

  function connectSSE() {
    if (eventSource) return;

    eventSource = new EventSource('/api/events');

    eventSource.onmessage = function (e) {
      try {
        var event = JSON.parse(e.data);

        if (event.type === 'task-status') {
          handleTaskStatus(event);
        }
      } catch (_) {
        // Ignore parse errors (keepalive comments, etc.)
      }
    };

    eventSource.onerror = function () {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      // Reconnect after delay — full board re-fetch on reconnect
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(function () {
        connectSSE();
        // Full board re-fetch to avoid stale state
        var boardSlot = document.getElementById('task-board-slot');
        if (boardSlot && boardSlot.style.display !== 'none') {
          htmx.trigger(boardSlot, 'refresh');
        }
      }, 3000);
    };
  }

  function handleTaskStatus(event) {
    var taskId = event.taskId;
    var newStatus = event.status;

    if (!taskId || !newStatus) return;

    var boardSlot = document.getElementById('task-board-slot');
    if (!boardSlot || boardSlot.style.display === 'none') return;

    var card = boardSlot.querySelector('[data-task-id="' + taskId + '"]');
    var newColumn = STATUS_TO_COLUMN[newStatus];

    if (!newColumn) return;

    var targetBody = document.querySelector(
      '#kanban-col-' + newColumn + ' .kanban-column__body',
    );
    if (!targetBody) return;

    if (card) {
      var currentCol = card.closest('.kanban-column');
      var currentColId = currentCol ? currentCol.getAttribute('data-column') : null;

      if (currentColId === newColumn) {
        // Same column — just update the status badge (SSE swap handles this)
        card.setAttribute('data-task-status', newStatus);
        return;
      }

      // Animate card out of old column
      card.classList.add('kanban-card--exiting');
      setTimeout(function () {
        // Move to new column
        card.classList.remove('kanban-card--exiting');
        card.setAttribute('data-task-status', newStatus);

        // Remove empty state from target if present
        var empty = targetBody.querySelector('.kanban-column__empty');
        if (empty) empty.remove();

        // Add to new column with entrance animation
        if (newColumn === 'inbox') {
          // Inbox: newest-first (prepend)
          targetBody.insertBefore(card, targetBody.firstChild);
        } else {
          // Others: oldest-first (append before "show all" link)
          var showAll = targetBody.querySelector('.kanban-column__show-all');
          if (showAll) {
            targetBody.insertBefore(card, showAll);
          } else {
            targetBody.appendChild(card);
          }
        }

        card.classList.add('kanban-card--entering');
        setTimeout(function () {
          card.classList.remove('kanban-card--entering');
        }, 300);

        // Update column counts
        updateColumnCounts();

        // Add empty state to old column if needed
        if (currentCol) {
          var oldBody = currentCol.querySelector('.kanban-column__body');
          if (oldBody && !oldBody.querySelector('.kanban-card')) {
            var emptyDiv = document.createElement('div');
            emptyDiv.className = 'kanban-column__empty';
            emptyDiv.textContent = 'No tasks';
            oldBody.appendChild(emptyDiv);
          }
        }
      }, 200);
    } else {
      // Card not on the board (new task or page was stale) — full refresh
      htmx.trigger(boardSlot, 'refresh');
    }
  }

  function updateColumnCounts() {
    var columns = ['inbox', 'investigating', 'review', 'pipeline', 'done', 'failed'];
    columns.forEach(function (colId) {
      var col = document.getElementById('kanban-col-' + colId);
      var countEl = document.getElementById('kanban-count-' + colId);
      if (!col || !countEl) return;
      var cards = col.querySelectorAll('.kanban-card');
      countEl.textContent = cards.length;
    });
  }

  // Connect when on the tasks page
  function maybeConnect() {
    if (document.getElementById('task-board-slot')) {
      connectSSE();
    }
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeConnect);
  } else {
    maybeConnect();
  }

  // Cleanup on page unload
  window.addEventListener('beforeunload', function () {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  });
})();
