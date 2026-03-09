/**
 * Kanban board drag-and-drop using SortableJS.
 *
 * Valid transitions map (column-level):
 *   inbox → investigating, pipeline
 *   review → inbox, pipeline
 *   failed → inbox, pipeline, done
 *
 * Investigating, Pipeline, Done columns do not accept manual drops.
 */

(function () {
  'use strict';

  var VALID_DROPS = {
    inbox: ['investigating', 'pipeline'],
    review: ['inbox', 'pipeline'],
    failed: ['inbox', 'pipeline', 'done'],
  };

  // Map column drops to backend endpoints
  var DROP_ACTIONS = {
    'inbox->investigating': { url: '/api/tasks/{id}/start-investigate', method: 'POST' },
    'inbox->pipeline': { url: '/api/tasks/{id}/force-queue', method: 'POST' },
    'review->inbox': { url: '/api/tasks/{id}/retry', method: 'POST' },
    'review->pipeline': { url: '/api/tasks/{id}/force-queue', method: 'POST' },
    'failed->inbox': { url: '/api/tasks/{id}/retry', method: 'POST' },
    'failed->pipeline': { url: '/api/tasks/{id}/retry-execute', method: 'POST' },
    'failed->done': { url: '/api/tasks/{id}/mark-done', method: 'POST' },
  };

  function initKanbanDrag() {
    var bodies = document.querySelectorAll('.kanban-column__body');
    if (!bodies.length || typeof Sortable === 'undefined') return;

    bodies.forEach(function (body) {
      var column = body.getAttribute('data-column');
      var canPull = column in VALID_DROPS;

      Sortable.create(body, {
        group: {
          name: 'kanban',
          pull: canPull,
          put: function (to) {
            // Check if this column accepts drops from any source
            var toCol = to.el.getAttribute('data-column');
            // This column accepts drops if any source can drop here
            for (var src in VALID_DROPS) {
              if (VALID_DROPS[src].indexOf(toCol) !== -1) return true;
            }
            return false;
          },
        },
        animation: 200,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        filter: '.kanban-column__empty, .kanban-column__show-all',
        onEnd: function (evt) {
          var fromCol = evt.from.getAttribute('data-column');
          var toCol = evt.to.getAttribute('data-column');
          var card = evt.item;
          var taskId = card.getAttribute('data-task-id');

          // Same column — no action needed
          if (fromCol === toCol) return;

          // Check if this is a valid transition
          var validTargets = VALID_DROPS[fromCol];
          if (!validTargets || validTargets.indexOf(toCol) === -1) {
            // Invalid drop — revert
            evt.from.insertBefore(card, evt.from.children[evt.oldIndex] || null);
            card.classList.add('kanban-card--invalid-drop');
            setTimeout(function () {
              card.classList.remove('kanban-card--invalid-drop');
            }, 300);
            return;
          }

          // Find the backend action
          var key = fromCol + '->' + toCol;
          var action = DROP_ACTIONS[key];
          if (!action) {
            // No action defined — revert
            evt.from.insertBefore(card, evt.from.children[evt.oldIndex] || null);
            return;
          }

          var url = action.url.replace('{id}', taskId);

          // Perform the backend call
          fetch(url, {
            method: action.method,
            headers: { 'Content-Type': 'application/json' },
          })
            .then(function (res) {
              if (!res.ok) throw new Error('Failed: ' + res.status);
              // Refresh the board
              var boardSlot = document.getElementById('task-board-slot');
              if (boardSlot) htmx.trigger(boardSlot, 'refresh');
            })
            .catch(function () {
              // Revert card position on error
              evt.from.insertBefore(card, evt.from.children[evt.oldIndex] || null);
              card.classList.add('kanban-card--invalid-drop');
              setTimeout(function () {
                card.classList.remove('kanban-card--invalid-drop');
              }, 300);
            });
        },
        onMove: function (evt) {
          var fromCol = evt.from.getAttribute('data-column');
          var toCol = evt.to.getAttribute('data-column');
          var validTargets = VALID_DROPS[fromCol];
          if (!validTargets || validTargets.indexOf(toCol) === -1) {
            return false; // Prevent drop
          }
        },
      });
    });
  }

  // Initialize on page load and after HTMX swaps (board refresh)
  document.addEventListener('DOMContentLoaded', initKanbanDrag);
  document.body.addEventListener('htmx:afterSwap', function (evt) {
    if (evt.detail.target.id === 'task-board-slot') {
      initKanbanDrag();
    }
  });
})();
