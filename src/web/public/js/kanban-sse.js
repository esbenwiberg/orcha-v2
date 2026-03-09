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
        } else if (event.type === 'task-transcript') {
          handleTaskTranscript(event);
        } else if (event.type === 'task-updated') {
          // Investigation completed or card data changed — refresh the board
          var boardSlot = document.getElementById('task-board-slot');
          if (boardSlot && boardSlot.style.display !== 'none') {
            htmx.trigger(boardSlot, 'refresh');
          }
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

  var EVENT_TYPE_LABELS = {
    system: 'Starting\u2026',
    assistant: 'Thinking\u2026',
    content_block_start: 'Thinking\u2026',
    content_block_delta: 'Thinking\u2026',
    tool_use: 'Using tools\u2026',
    tool_result: 'Analyzing\u2026',
    result: 'Finishing\u2026',
  };

  function handleTaskTranscript(event) {
    var taskId = event.taskId;
    if (!taskId) return;

    var activityEl = document.getElementById('kanban-activity-' + taskId);
    if (!activityEl) return;

    // Increment event count
    var count = parseInt(activityEl.getAttribute('data-event-count') || '0', 10) + 1;
    activityEl.setAttribute('data-event-count', String(count));

    // Determine friendly label
    var eventType = event.event && event.event.type ? event.event.type : '';
    var label = EVENT_TYPE_LABELS[eventType] || 'Working\u2026';
    var phasePrefix = event.phase === 'enrich' ? 'Enriching' : event.phase === 'execute' ? 'Running' : '';
    if (phasePrefix && label === 'Working\u2026') {
      label = phasePrefix + '\u2026';
    }

    // Update the activity element
    var textEl = activityEl.querySelector('.kanban-card__activity-text');
    if (textEl) {
      textEl.textContent = label + ' (' + count + ')';
    }

    // Ensure visible + working state
    activityEl.style.display = '';
    activityEl.className = 'kanban-card__activity kanban-card__activity--working';

    // Ensure the dot is present
    var dot = activityEl.querySelector('.kanban-card__activity-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'kanban-card__activity-dot';
      activityEl.insertBefore(dot, activityEl.firstChild);
    }
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
