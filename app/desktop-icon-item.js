
/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2021 Sundeep Mediratta (smedius@gmail.com)
 * Copyright (C) 2019 Sergio Costas (rastersoft@gmail.com)
 * Based on code original (C) Carlos Soriano
 * SwitcherooControl code based on code original from Marsch84
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
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Gsk from 'gi://Gsk';
import Graphene from 'gi://Graphene';

import * as dndClipboardUtils from './dnd-clipboard-utils.js';
import * as DesktopIconsUtil from './desktop-icons-util.js';
import * as Prefs from './preferences.js';
import * as Enums from './enums.js';
import * as SignalManager from './signal-manager.js';
import * as DebugLog from './log.js';

import * as Signals from './signals.js';
import Gettext from 'gettext';

const _ = Gettext.domain('ding').gettext;

/** Aspect-fit source pixels into a square icon box and center the result. */
export function calculateThumbnailPlacement(sourceWidth, sourceHeight, boxSize) {
    const scale = Math.min(boxSize / sourceWidth, boxSize / sourceHeight);
    const width = Math.max(1, Math.floor(sourceWidth * scale));
    const height = Math.max(1, Math.floor(sourceHeight * scale));
    return {
        width,
        height,
        x: Math.floor((boxSize - width) / 2),
        y: Math.floor((boxSize - height) / 2),
    };
}

/* Icon+label block vertical offset inside the selection box. The block is
   top-aligned (icons of one-line and two-line names sit at the same row,
   like before the 2026-09-08 centering attempt), shifted down by this much
   so it does not hug the box top edge. The label area gets the remainder:
   height - decoration(4) - icon_size - 6, which is 42 for every icon-size
   level (pitch = icon_size + 48) — exactly 2 label lines (40) +
   margin_bottom (2) at the default font. docs/fixes.md 2026-09-08. */
const contentTopOffset = 6;

export var desktopIconItem = class desktopIconItem extends SignalManager.SignalManager {
    constructor(desktopManager, fileExtra) {
        super();
        this._desktopManager = desktopManager;
        this._fileExtra = fileExtra;
        this._loadThumbnailDataCancellable = null;
        this._queryFileInfoCancellable = null;
        this._grid = null;
        this._lastClickTime = 0;
        this._lastClickButton = 0;
        this._clickCount = 0;
        this._isSelected = false;
        this._isKeyboardSelected = false;
        this._isBeingDragged = false;
        this._isSpecial = false;
        this._savedCoordinates = null;
        this._dropCoordinates = null;
        this._destroyed = false;
        this._relativeX = 0.5;
    }

    /** *********************
     * Destroyers *
     ***********************/

    removeFromGrid(callOnDestroy) {
        if (this._grid) {
            this._grid.removeItem(this);
            this._grid = null;
        }
        if (callOnDestroy) {
            this._onDestroy();
        }
    }

    _destroy() {
        this._destroyed = true;
        /* Regular file data */
        if (this._queryFileInfoCancellable) {
            this._queryFileInfoCancellable.cancel();
            this._queryFileInfoCancellable = null;
        }

        /* Thumbnailing */
        if (this._loadThumbnailDataCancellable) {
            this._loadThumbnailDataCancellable.cancel();
            this._loadThumbnailDataCancellable = null;
        }
        /* Disconnect signals */
        this.disconnectAllSignals();
        this.container = null;
        this._icon = null;
        this._label = null;
        this._containerRectangle = null;
        if (this._grid) {
            this._grid.removeItem(this);
            this._grid = null;
        }
        this._desktopManager = null;
        this._fileExtra = null;
        this._savedCoordinates = null;
        this._dropCoordinates = null;
    }

    _onDestroy() {
        if (!this._destroyed) {
            this._destroy();
        }
    }

    /** *********************
     * Creators *
     ***********************/

    _createIconActor(role) {
        /* Top-aligned vertical box: children fill from the top, and because
           the label area is pinned to an exact height (setCoordinates), the
           block height is identical for one-line and two-line names, so all
           icons in a row line up and label positions are consistent.
           (docs/fixes.md 2026-09-08) */
        this.container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.START,
        });
        this.connectSignal(this.container, 'destroy', () => this._onDestroy());

        this.connectSignal(Prefs.nautilusSettings, 'changed', () => {
            this._setCursor();
        });
        this._setCursor();

        this._icon = new Gtk.Picture({
            can_shrink: false,
            // SCALE_DOWN (not keep_aspect_ratio): draws the paintable at its
            // intrinsic size, scaled down only, centered. keep_aspect_ratio
            // measures a for_size-coupled natural height (natural =
            // for_size * h/w), so inside the natural-sized contentBox a
            // portrait thumbnail (e.g. 44x64) made the Picture grow to
            // ~64x94 and the label overlapped the icon (docs/fixes.md
            // 2026-09-08).
            content_fit: Gtk.ContentFit.SCALE_DOWN,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.START,
            vexpand: false,
        });

        /* The label area height is pinned in setCoordinates() (fixed block
           height keeps one-line/two-line icons and labels aligned); the
           label text is top-anchored, so it always sits directly under the
           icon, and the reserved second line stays below short names. */
        const labelContainer = new Gtk.Box();
        this._label = new Gtk.Label({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.START,
            vexpand: false,
            natural_wrap_mode: Gtk.NaturalWrapMode.WORD,
            ellipsize: Pango.EllipsizeMode.END,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            yalign: 0.0,
            xalign: 0.5,
            justify: Gtk.Justification.CENTER,
            lines: 2,
        });
        // GTK4 dropped the GTK3 'size-allocate' signal, and Gtk.Widget has
        // no 'allocation' GObject property either (so notify::allocation is
        // a silently-dead connection). 'realize' is the closest reliable
        // hook: it fires exactly once when the label joins the widget tree,
        // by which time the file name and newFolderDoRename are both set.
        // Drives _doLabelSizeAllocated() (geometry bookkeeping) and, in
        // FileItem, _checkForRename() — without this connection the
        // "rename newly created folder" flow never fires.
        DebugLog.debugLog(`[rename] label realize hook connected`);
        this.connectSignal(this._label, 'realize',
            () => this._doLabelSizeAllocated());
        labelContainer.append(this._label);
        labelContainer.set_layout_manager(new Gtk.BinLayout());
        // Kept for setCoordinates(): the label area height is pinned so the
        // icon+label block has a fixed height (docs/fixes.md 2026-09-08).
        this._labelContainer = labelContainer;

        this._accessibleBox = new Gtk.Box({
            focusable: true,
            can_focus: true,
            accessible_role: role,
        });

        this._applyDarkTextClass();

        this.container.append(this._icon);
        this.container.append(labelContainer);
        this.container.append(this._accessibleBox);

        this._icon.add_css_class('icon-item');
        this.container.add_css_class('file-item');

        this._containerRectangle = new Gdk.Rectangle();

        let buttonMainController = new Gtk.GestureClick();
        buttonMainController.propagation_phase = Gtk.PropagationPhase.BUBBLE;
        this.container.add_controller(buttonMainController);
        buttonMainController.button = 1;
        this.connectSignal(buttonMainController, 'pressed', this._doButtonOnePressed.bind(this));
        this.connectSignal(buttonMainController, 'released', this._onReleaseButton.bind(this));

        let buttonMenuController = new Gtk.GestureClick();
        buttonMenuController.propagation_phase = Gtk.PropagationPhase.BUBBLE;
        this.container.add_controller(buttonMenuController);
        buttonMenuController.button = 3;
        this.connectSignal(buttonMenuController, 'pressed', this._doButtonThreePressed.bind(this));

        let motionController = new Gtk.EventControllerMotion();
        this.container.add_controller(motionController);
        this.connectSignal(motionController, 'enter', this._onEnter.bind(this));
        this.connectSignal(motionController, 'leave', this._onLeave.bind(this));

        this._setDragSource(this.container);
        this.container.show();
    }

    /* Keeps the label CSS class in sync with the dark-text setting. Used at
     * creation and by the fast-path refresh, which reuses the widget. */
    _applyDarkTextClass() {
        if (this._label === null) {
            return;
        }
        if (this._desktopManager.darkText) {
            this._label.remove_css_class('file-label');
            this._label.add_css_class('file-label-dark');
        } else {
            this._label.remove_css_class('file-label-dark');
            this._label.add_css_class('file-label');
        }
    }

    _doLabelSizeAllocated() {
        DebugLog.debugLog(`[rename] label realized (${this.fileName ?? '?'})`);
        this._calculateLabelRectangle();
    }

    _setCursor() {
        if (Prefs.nautilusSettings.get_string('click-policy') === 'single') {
            this.container.set_cursor_from_name('pointer');
        } else {
            this.container.set_cursor(null);
        }
    }

    checkIntersects(rectangle) {
        return (this._containerRectangle.intersect(rectangle)[0]);
    }

    _calculateLabelRectangle() {
        this.labelwidth = this._label.get_allocated_width();
        this.labelheight = this._label.get_allocated_height();
    }

    setCoordinates(x, y, width, height, margin, grid, relativeX) {
        this._x1 = x;
        this._y1 = y;
        this._relativeX = relativeX;
        this.width = width;
        this.height = height;
        this._grid = grid;
        // Fix the container to the full grid cell (same size the drop-grid
        // preview draws in PaintContainer): selection boxes then have a
        // uniform height/width per icon-size level and align exactly with
        // the drag positioning grid. (docs/fixes.md 2026-09-07)
        this.container.set_size_request(width, height);
        // The Picture is pinned to icon_size x icon_size and
        // content_fit=SCALE_DOWN renders the pre-scaled paintable at its
        // intrinsic size, decoupled from the parent width (docs/fixes.md
        // 2026-09-07/08). The block is top-aligned; contentTopOffset shifts
        // icon+label down so they do not hug the box edge, and the label
        // area takes the remaining height — a fixed block height per item,
        // so icons in a row stay aligned.
        const iconSize = Prefs.get_icon_size();
        this._icon.set_size_request(iconSize, iconSize);
        this._icon.margin_top = contentTopOffset;
        const decoration = 4; // .file-item border 1px*2 + padding 1px*2
        this._labelContainer.set_size_request(-1,
            Math.max(1, height - decoration - iconSize - contentTopOffset));
        this._label.margin_start = margin;
        this._label.margin_end = margin;
        this._label.margin_bottom = margin;
        this._containerRectangle.x = this._x1;
        this._containerRectangle.y = this._y1;
        this._containerRectangle.width = this.width;
        this._containerRectangle.height = this.height;
    }

    getCoordinates() {
        this._x2 = this._x1 + this.container.get_allocated_width() - 1;
        this._y2 = this._y1 + this.container.get_allocated_height() - 1;
        return [this._x1, this._y1, this._x2, this._y2, this._grid];
    }

    _setLabelName(text) {
        this._currentFileName = text;
        this.container.set_tooltip_text(text);
        let lastCutPos = -1;
        const chars = [];
        for (let pos = 0; pos < text.length; pos++) {
            let character = text[pos];
            chars.push(character);
            if (pos < (text.length - 1)) {
                var nextChar = text[pos + 1];
            } else {
                var nextChar = '';
            }
            if (character == ' ') {
                lastCutPos = pos;
            }
            if (['.', ',', '-', '_', '@', ':'].includes(character)) {
                /* if the next character is already an space or this is the last
                 * character, the string will be naturally cut here, so we do
                 * nothing.
                 */
                if ((nextChar == ' ') || (nextChar == '')) {
                    continue;
                }
                /* if there is a cut element in the last four previous characters,
                 * do not add a new cut element.
                 */
                if ((lastCutPos > -1) && ((pos - lastCutPos) < 4)) {
                    continue;
                }
                chars.push('\u200B');
            }
        }
        // adding a CR at the end ensures that the text has always two lines, and
        // that allows to have same-size icons.
        this._label.label = chars.join('');
    }

    /** *********************
     * Button Clicks *
     ***********************/

    _onReleaseButton(controller, n_press, x, y) {
        let state = DesktopIconsUtil.getControllerStatus(controller);
        if (n_press == 1) {
            if (state.shift || state.control) {
                this._desktopManager.selected(this, Enums.Selection.WITH_SHIFT);
            } else {
                this._desktopManager.selected(this, Enums.Selection.ALONE);
            }
        }
        this._doButtonOneReleased(controller, n_press, x, y, state);
    }

    _doButtonThreePressed(controller, n_press, x, y) {
        controller.set_state(Gtk.EventSequenceState.CLAIMED);
        this._buttonPressInitialX = x;
        this._buttonPressInitialY = y;
        if (n_press != 1) {
            return;
        }
        if (!this._isSelected) {
            this._desktopManager.selected(this, Enums.Selection.RIGHT_BUTTON);
        }
        this._desktopManager.showFileMenu(this, x, y);
    }

    _doButtonOnePressed(controller, n_press, x, y) {
        this._buttonPressInitialX = x;
        this._buttonPressInitialY = y;
        let state = DesktopIconsUtil.getControllerStatus(controller);
        if (!this._isSelected && !state.shift && !state.control) {
            this._desktopManager.selected(this, Enums.Selection.ALONE);
        }
        // don't manage the click event in the grid.
        // We can't use EVENT_STOP or similar because that would break
        // the Drag'n'Drop controller.
        this._desktopManager.clickCaptured();
    }


    _doButtonOneReleased(controller, n_press, x, y, state) {
        controller.set_state(Gtk.EventSequenceState.CLAIMED);
    }

    /** *********************
     * Drag and Drop *
     ***********************/

    _onEnter() {
        if (!this.container.has_css_class('file-item-hover')) {
            this.container.add_css_class('file-item-hover');
        }
        return false;
    }

    _onLeave() {
        if (this.container.has_css_class('file-item-hover')) {
            this.container.remove_css_class('file-item-hover');
        }
        return false;
    }

    _hasToRouteDragToGrid() {
        return !!this._grid;
    }

    _updateDragStatus(context, time) {
        if (DesktopIconsUtil.getModifiersInDnD(context, Gdk.ModifierType.CONTROL_MASK)) {
            Gdk.drag_status(context, Gdk.DragAction.COPY, time);
        } else {
            Gdk.drag_status(context, Gdk.DragAction.MOVE, time);
        }
    }

    highLightDropTarget() {
        if (this._hasToRouteDragToGrid()) {
            this._grid.refreshDrag(this._desktopManager.getDragList() || [[0, 0]], this._x1, this._y1);
            return;
        }
        if (!this.container.has_css_class('desktop-icons-selected')) {
            this.container.add_css_class('desktop-icons-selected');
        }
        this._grid.highLightGridAt(this._x1, this._y1);
    }

    unHighLightDropTarget() {
        if (this._hasToRouteDragToGrid()) {
            this._grid.receiveLeave();
            return;
        }
        if (!this._isSelected && this.container.has_css_class('desktop-icons-selected')) {
            this.container.remove_css_class('desktop-icons-selected');
        }
        this._grid.unHighLightGrids();
    }

    setSelected() {
        this._isSelected = true;
        this._setSelectedStatus();
    }

    unsetSelected() {
        this._isSelected = false;
        this._setSelectedStatus();
    }

    toggleSelected() {
        this._isSelected = !this._isSelected;
        this._setSelectedStatus();
    }

    _setSelectedStatus() {
        let grab_focus = false;
        // Selection fill AND outline are CSS on this container
        // (.desktop-icons-selected / -keyboard), so no overlay
        // invalidation is needed here; the widget's own style recalc
        // redraws it. (The outline briefly lived in the grid's
        // PaintContainer, but that ghosted when a grid map entry outlived
        // its widget — docs/fixes.md 2026-09-08.)
        if (this._isKeyboardSelected && this.container && !this.container.has_css_class('desktop-icons-selected-keyboard')) {
            this.container.add_css_class('desktop-icons-selected-keyboard');
            if (this._isKeyboardSelected) {
                grab_focus = true;
            }
        }
        if (!this._isKeyboardSelected && this.container && this.container.has_css_class('desktop-icons-selected-keyboard')) {
            this.container.remove_css_class('desktop-icons-selected-keyboard');
        }
        if (this._isSelected && this.container && !this.container.has_css_class('desktop-icons-selected')) {
            this.container.add_css_class('desktop-icons-selected');
            if (this._isKeyboardSelected) {
                grab_focus = true;
            }
        }
        if (!this._isSelected && this.container && this.container.has_css_class('desktop-icons-selected')) {
            this.container.remove_css_class('desktop-icons-selected');
        }
        if (grab_focus) {
            this.setAccessibleName(this._getVisibleName());
            this._accessibleBox.grab_focus();
        }
    }

    _setDragSource(widget) {
        const dragController = new Gtk.DragSource();
        dragController.set_actions(Gdk.DragAction.MOVE | Gdk.DragAction.COPY | Gdk.DragAction.ASK);
        widget.add_controller(dragController);
        this.connectSignal(dragController, 'prepare', () => {
            if (!this.isSelected) {
                this.setSelected();
            }
            let selection = this._desktopManager.getCurrentSelection(false);
            return dndClipboardUtils.loadDragData({fileList:selection, specialFilesSelected: this._desktopManager.checkIfSpecialFilesAreSelected()});
        })
        this.connectSignal(dragController, 'drag-begin', () => {
            this._isBeingDragged = true;
            this._desktopManager.onDragBegin(this);
            const paintable = this._createDragIcon();
            if (paintable) {
                dragController.set_icon(paintable, 32, 32);
            }
        });
        this.connectSignal(dragController, 'drag-end', () => {
            this._isBeingDragged = false;
            this._desktopManager.onDragEnd();
        });
    }

    _createDragIcon() {
        try {
            return this._createDragIconImpl();
        } catch(e) {
            return this._icon.get_paintable();
        }
    }

    _createDragIconImpl() {
        const selection = this._desktopManager.getCurrentSelection(false);
        if (!selection || selection.length === 0)
            return this._icon.get_paintable();

        const iconSize = 64;
        const MAX_DRAWN_ICONS = 4;
        const BADGE_SIZE = 20;
        const count = selection.length;
        const drawCount = Math.min(count, MAX_DRAWN_ICONS);

        if (drawCount === 1)
            return this._icon.get_paintable();

        // Reorder so the drag initiator (this) is last (drawn on top)
        let ordered = selection.filter(item => item !== this);
        ordered.push(this);
        ordered = ordered.slice(-drawCount);

        // Calculate offsets: vertical stacking with horizontal alternation
        const dy = drawCount === 2 ? 10 : drawCount === 3 ? 6 : 4;
        let offsets = [];
        for (let i = 0; i < drawCount; i++) {
            const dx = i === 0 ? 0 : (i % 2 === 1 ? 6 : -6);
            offsets.push({dx, dy: dy * i});
        }

        // Composite size
        let compWidth = iconSize + BADGE_SIZE / 2;
        let compHeight = iconSize + BADGE_SIZE / 2;
        for (let i = 0; i < drawCount; i++) {
            compWidth = Math.max(compWidth, offsets[i].dx + iconSize);
            compHeight = Math.max(compHeight, offsets[i].dy + iconSize);
        }

        const snapshot = new Gtk.Snapshot();

        // Paint icons bottom to top so last is on top
        for (let i = drawCount - 1; i >= 0; i--) {
            const item = ordered[i];
            const paintable = item._icon.get_paintable();
            if (!paintable) continue;
            const p = new Graphene.Point();
            p.init(offsets[i].dx, offsets[i].dy);
            snapshot.save();
            snapshot.translate(p);
            paintable.snapshot(snapshot, iconSize, iconSize);
            snapshot.restore();
        }

        // Count badge at bottom-right
        const badgeX = compWidth - BADGE_SIZE;
        const badgeY = compHeight - BADGE_SIZE;
        const badgeRect = new Graphene.Rect();
        badgeRect.init(badgeX, badgeY, BADGE_SIZE, BADGE_SIZE);

        const badgeColor = new Gdk.RGBA();
        badgeColor.parse('#333333dd');

        const roundedRect = new Gsk.RoundedRect();
        roundedRect.init_from_rect(badgeRect, BADGE_SIZE / 2);

        snapshot.push_rounded_clip(roundedRect);
        snapshot.append_color(badgeColor, badgeRect);
        snapshot.pop();

        // Draw count text centered in badge
        const pangoContext = this._icon.get_pango_context();
        const layout = Pango.Layout.new(pangoContext);
        layout.set_text(String(count), -1);
        layout.set_font_description(Pango.FontDescription.from_string('bold 11'));

        let [, logicalRect] = layout.get_pixel_extents();
        const textX = badgeX + (BADGE_SIZE - logicalRect.width) / 2;
        const textY = badgeY + (BADGE_SIZE - logicalRect.height) / 2;

        const textColor = new Gdk.RGBA();
        textColor.parse('#ffffff');

        const tp = new Graphene.Point();
        tp.init(textX, textY);
        snapshot.save();
        snapshot.translate(tp);
        snapshot.append_layout(layout, textColor);
        snapshot.restore();

        return snapshot.to_paintable(null);
    }

    _calculateOffset(widget) {
        return [((this.width - this.labelwidth) / 2) + this._buttonPressInitialX, (this.iconheight + 2) + this._buttonPressInitialY];
    }

    _setDropDestination(dropDestination) {}

    /** *********************
     * Icon Rendering *
     ***********************/

    updateIcon() {
        this._updateIcon().catch(logError);
    }

    async _updateIcon() {
        if (this._destroyed) {
            return;
        }

        try {
            let customIcon = this._fileInfo.get_attribute_as_string('metadata::custom-icon');
            if (customIcon && (customIcon != '')) {
                let customIconFile = Gio.File.new_for_uri(customIcon);
                if (customIconFile.query_exists(null)) {
                    let loadedImage = await this._loadImageAsIcon(customIconFile);
                    if (loadedImage || this._destroyed) {
                        return;
                    }
                }
            }
        } catch (error) {
            console.error(error, `Error while updating icon: ${error.message}`);
        }
        if (this._destroyed) {
            return;
        }

        if (this._fileExtra === Enums.FileType.USER_DIRECTORY_TRASH) {
            const iconPaintable = this._createEmblemedIcon(this._fileInfo.get_icon(), null);
            this._icon.set_paintable(iconPaintable);
            return;
        }
        let iconSet = false;
        if (Prefs.nautilusSettings.get_string('show-image-thumbnails') != 'never') {
            let thumbnail = await this._desktopManager.thumbnailLoader.getThumbnail(this);
            if (this._destroyed) {
                return;
            }
            if (thumbnail != null) {
                let thumbnailFile = Gio.File.new_for_path(thumbnail);
                iconSet = await this._loadImageAsIcon(thumbnailFile);
                if (this._destroyed) {
                    return;
                }
            }
        }

        if (!iconSet) {
            let iconPaintable;
            if (this._isBrokenSymlink) {
                iconPaintable = this._createEmblemedIcon(null, 'text-x-generic');
            } else if (this._desktopFile && this._desktopFile.has_key('Icon')) {
                iconPaintable = this._createEmblemedIcon(null, this._desktopFile.get_string('Icon'));
            } else {
                iconPaintable = this._createEmblemedIcon(this._getDefaultIcon(), null);
            }
            // If the paintable isn't deleted first, it's not refreshed
            this._icon.set_paintable(null);
            this._icon.set_paintable(iconPaintable);
        }
    }

    _getDefaultIcon() {
        if (this._fileExtra == Enums.FileType.EXTERNAL_DRIVE) {
            return this._custom.get_icon();
        }
        return this._fileInfo.get_icon();
    }

    async _loadImageAsIcon(imageFile) {
        if (this._loadThumbnailDataCancellable) {
            this._loadThumbnailDataCancellable.cancel();
        }
        this._loadThumbnailDataCancellable = new Gio.Cancellable();

        try {
            const [thumbnailData] = await imageFile.load_bytes_async(this._loadThumbnailDataCancellable);
            if (this._destroyed) {
                return;
            }

            const iconTexture = Gdk.Texture.new_from_bytes(thumbnailData);
            const icon_size = Prefs.get_icon_size();
            const placement = calculateThumbnailPlacement(
                iconTexture.width, iconTexture.height, icon_size);
            let iconPaintableSnapshot = Gtk.Snapshot.new();
            const canvasRect = new Graphene.Rect();
            canvasRect.init(0, 0, icon_size, icon_size);
            iconPaintableSnapshot.append_color(
                new Gdk.RGBA({ red: 0, green: 0, blue: 0, alpha: 0 }),
                canvasRect);
            iconPaintableSnapshot.save();
            iconPaintableSnapshot.translate(new Graphene.Point({
                x: placement.x,
                y: placement.y,
            }));
            iconTexture.snapshot(iconPaintableSnapshot,
                placement.width, placement.height);
            iconPaintableSnapshot.restore();
            let icon = iconPaintableSnapshot.to_paintable(null);
            icon = this._addEmblemsToIconIfNeeded(icon);
            if (this._icon) {
                // The loader only replaces the content of the fixed icon
                // box. Its margins belong to setCoordinates(), so an async
                // thumbnail refresh cannot move the box or the label.
                this._icon.set_paintable(icon);
                this._icon.show();
            } else {
                console.error('Icon is null');
            }
            return true;
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                return;
            }

            console.error(e, `Error while loading ${imageFile.get_uri()} as icon`);
            return false;
        }
    }

    _addEmblemsToIconIfNeeded(iconPaintable) {
        let emblem = this._getEmblem();

        if (emblem) {
            // Align with Nautilus' emblem rendering (nautilus-grid-cell.c
            // update_emblems + nautilus-grid-cell.blp):
            // - emblems are rendered at their natural theme size (Adwaita's
            //   emblem icons are 16x16), without FORCE_SIZE upscaling
            // - emblems are dimmed: Nautilus puts them in a box with the
            //   'dim-label' style class, which the GTK default theme maps to
            //   opacity 0.55. We use a slightly stronger 0.75 so the emblem
            //   stays clearly visible over the icon.
            // - the emblem sits at the icon's top-right corner (Nautilus
            //   allocates its emblems box at the right edge of the cell)
            const EMBLEM_SIZE = 16;
            const EMBLEM_OPACITY = 0.75;
            const scale = this._icon.get_scale_factor();
            let theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
            let emblemIcon = theme.lookup_by_gicon(emblem, EMBLEM_SIZE, scale, Gtk.TextDirection.NONE, 0);
            if (!emblemIcon)
                return iconPaintable;

            let emblemSnapshot = Gtk.Snapshot.new();
            let iconPaintableSnapshot = Gtk.Snapshot.new();
            emblemIcon.snapshot(emblemSnapshot, emblemIcon.get_intrinsic_width(), emblemIcon.get_intrinsic_height());
            const iconWidth = iconPaintable.get_intrinsic_width();
            const iconHeight = iconPaintable.get_intrinsic_height();
            const emblemWidth = emblemIcon.get_intrinsic_width();

            iconPaintable.snapshot(iconPaintableSnapshot, iconWidth, iconHeight);
            iconPaintableSnapshot.push_opacity(EMBLEM_OPACITY);
            let pos = new Graphene.Point();
            pos.init(iconWidth - emblemWidth, 0);
            iconPaintableSnapshot.translate(pos);
            iconPaintableSnapshot.append_node(emblemSnapshot.to_node());
            iconPaintableSnapshot.pop();
            return iconPaintableSnapshot.to_paintable(null);
        } else {
            return iconPaintable;
        }
    }

    _createEmblemedIcon(icon, iconName) {
        if (icon === null) {
            if (GLib.path_is_absolute(iconName)) {
                try {
                    let iconFile = Gio.File.new_for_commandline_arg(iconName);
                    icon = new Gio.FileIcon({ file: iconFile });
                } catch (e) {
                    icon = Gio.ThemedIcon.new_with_default_fallbacks(iconName);
                }
            } else {
                try {
                    icon = Gio.Icon.new_for_string(iconName);
                } catch (e) {
                    icon = Gio.ThemedIcon.new_with_default_fallbacks(iconName);
                }
            }
        }
        let theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        const scale = this._icon.get_scale_factor();
        let iconPaintable = null;
        try {
            iconPaintable = theme.lookup_by_gicon(icon, Prefs.get_icon_size(), scale, Gtk.TextDirection.NONE, Gtk.IconLookupFlags.FORCE_SIZE);
        } catch (e) {
            iconPaintable = theme.lookup_icon('text-x-generic', [], Prefs.get_icon_size(), scale, Gtk.TextDirection.NONE, Gtk.IconLookupFlags.FORCE_SIZE);
        }
        return this._addEmblemsToIconIfNeeded(iconPaintable);
    }

    /** *********************
     * Getters and setters *
     ***********************/

    get state() {
        return this._state;
    }

    set state(state) {
        if (state == this._state) {
            return;
        }

        this._state = state;
    }

    get grid() {
        return this._grid;
    }
    get isDrive() {
        return this._fileExtra == Enums.FileType.EXTERNAL_DRIVE;
    }

    get isSelected() {
        return this._isSelected;
    }

    get isKeyboardSelected() {
        return this._isKeyboardSelected;
    }

    set isKeyboardSelected(status) {
        this._isKeyboardSelected = status;
        this._setSelectedStatus();
    }

    get isSpecial() {
        return this._isSpecial;
    }

    get dropCoordinates() {
        return this._dropCoordinates;
    }

    get relativeX() {
        return this._relativeX;
    }

    set dropCoordinates(pos) {
        this._dropCoordinates = pos;
    }
};
Signals.addSignalMethods(desktopIconItem.prototype);
