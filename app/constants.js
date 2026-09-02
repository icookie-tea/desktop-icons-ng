/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2019 Sergio Costas (rastersoft@gmail.com)
 * Based on code original (C) Carlos Soriano
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */


/* Timeouts and batch sizes (milliseconds unless noted). */
export var MONITOR_RATE_LIMIT_MS = 1000;        // GFileMonitor rate limit
export var FILE_CHANGES_DEBOUNCE_MS = 200;      // FileChangesQueue debounce window
export var MAX_INCREMENTAL_EVENTS = 8;          // FileChangesQueue immediate-flush batch size (bursts of pastes/extracts are handled in batches of this size; the queue only ever flushes ≤ this many events, the overflow guard in processIncrementalEvents stays as a defense)
export var KEYPRESS_SEARCH_TIMEOUT_MS = 1500;   // keyboard name-search reset timer
export var REFRESH_RETRY_DELAY_MS = 500;        // wait between full-refresh retries
export var DESKTOP_UPDATE_THROTTLE_US = 1000000; // force redraw if refresh took > 1s
export var MOVE_PENDING_TIMEOUT_MS = 150;       // MOVED_OUT -> MOVED_IN merge window
export var MOUNT_REMOVED_DELAY_MS = 500;        // delay before refreshing after mount-removed
export var MOUNT_RETRY_DELAY_MS = 1500;         // delay before a mount-query retry refresh
export var MOUNT_QUERY_MAX_RETRIES = 3;         // consecutive failures before giving up on a mount
export var THUMBNAIL_TIMEOUT_MS = 5000;         // thumbnail generation timeout
