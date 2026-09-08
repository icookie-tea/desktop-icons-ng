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
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gsk from 'gi://Gsk';
import Graphene from 'gi://Graphene';
import GObject from 'gi://GObject';

const elementSpacing = 2;

export var PaintContainer = class PaintContainer extends Gtk.Widget {
    static {
        GObject.registerClass(this);
    }

    constructor(desktopGrid) {
        super();
        this._desktopGrid = desktopGrid;
        this._selectedList = null;
        this._width = 0;
        this._height = 0;
        this._colors = null;
        // Immutable Gsk.Stroke objects shared by every outline in every
        // frame. Per-cell `new Gsk.Stroke()` in snapshot() was a major
        // allocation-churn source while the rubber band grew over a dense
        // desktop; append_stroke copies the stroke into the render node.
        this._stroke1 = new Gsk.Stroke(1);
        this._stroke2 = new Gsk.Stroke(2);
    }

    _updateColors(dm) {
        // Cache the RGBA objects and rebuild them only when the accent color
        // objects are replaced (ThemeManager assigns new Gdk.RGBA objects on
        // each configureSelectionColor()), avoiding per-frame allocations
        // while painting the rubberband / drop preview during drags.
        if (this._colors !== null &&
            this._colors.selectColor === dm.selectColor &&
            this._colors.accentColor === dm.accentColor) {
            return;
        }
        const { red, green, blue } = dm.selectColor;
        const accent = dm.accentColor ?? dm.selectColor;
        const { red: ar, green: ag, blue: ab } = accent;
        this._colors = {
            selectColor: dm.selectColor,
            accentColor: dm.accentColor,
            // libadwaita rubberband: border 1px var(--accent-color), background
            // color-mix(var(--accent-color) 20%, transparent). Fill raised to
            // 25% and the border to 2px so the band stays visible over
            // wallpaper (Nautilus has a solid view background).
            fillRubber: new Gdk.RGBA({ red: ar, green: ag, blue: ab, alpha: 0.25 }),
            borderRubber: new Gdk.RGBA({ red: ar, green: ag, blue: ab, alpha: 1.0 }),
            fillDrop: new Gdk.RGBA({ red, green, blue, alpha: 0.4 }),
            borderDrop: new Gdk.RGBA({ red, green, blue, alpha: 1.0 }),
            // Keyboard selection ring (was CSS border-color accent 70%).
            borderKeyboard: new Gdk.RGBA({ red: ar, green: ag, blue: ab, alpha: 0.7 }),
        };
    }

    get selectedList() {
        return this._selectedList;
    }

    set selectedList(value) {
        if (this._selectedList === value)
            return;

        this._selectedList = value;
        this.queue_draw();
    }

    setSize(width, height) {
        this._width = width;
        this._height = height;
        this.queue_resize();
    }

    vfunc_measure(orientation, forSize) {
        if (orientation === Gtk.Orientation.HORIZONTAL) {
            return [this._width, this._width, -1, -1];
        } else {
            return [this._height, this._height, -1, -1];
        }
    }

    vfunc_snapshot(snapshot) {
        const dm = this._desktopGrid._desktopManager;
        const grid = this._desktopGrid;

        this._updateColors(dm);

        /* Selection outlines: stroked with the exact same Gsk path as the
           drag drop-grid preview, so both render pixel-identically. A CSS
           border used to look softer (anti-aliased across two pixel rows
           when the widget edge sits at a fractional position); see
           docs/fixes.md 2026-09-07. The 35% fill stays in CSS.

           Perf: all selected cells are batched into ONE Gsk path per
           outline color and stroked once per frame; per-item paths used
           to allocate a path/Stroke/render node for every selected icon
           every frame (and Object.values() copied the whole _fileItems
           map), starving the frame budget during rubber-band drags
           (docs/fixes.md 2026-09-07). */
        let normalBuilder = null;
        let keyboardBuilder = null;
        for (let uri in grid._fileItems) {
            const entry = grid._fileItems[uri];
            const item = entry[2];
            if (!item || !item.isSelected)
                continue;
            const x = Math.floor(grid._width * entry[0] / grid._maxColumns);
            const y = Math.floor(grid._height * entry[1] / grid._maxRows);
            let builder = item.isKeyboardSelected ? keyboardBuilder : normalBuilder;
            if (builder === null) {
                builder = new Gsk.PathBuilder();
                if (item.isKeyboardSelected)
                    keyboardBuilder = builder;
                else
                    normalBuilder = builder;
            }
            this._appendRoundedRectPath(builder,
                x + elementSpacing, y + elementSpacing,
                grid._elementWidth - 2 * elementSpacing,
                grid._elementHeight - 2 * elementSpacing,
                10);
        }
        if (normalBuilder !== null) {
            snapshot.append_stroke(normalBuilder.to_path(), this._stroke1,
                this._colors.borderDrop);
        }
        if (keyboardBuilder !== null) {
            snapshot.append_stroke(keyboardBuilder.to_path(), this._stroke1,
                this._colors.borderKeyboard);
        }

        /* rubber band state lives on the SelectionManager */
        const sel = dm._selectionManager;
        if (sel.rubberBand && sel.selectionRectangle) {
            if (grid.gridGlobalRectangle.intersect(sel.selectionRectangle)[0]) {
                let [xInit, yInit] = grid.coordinatesGlobalToLocal(sel.x1, sel.y1);
                let [xFin, yFin] = grid.coordinatesGlobalToLocal(sel.x2, sel.y2);

                this._snapshotRoundedRect(snapshot,
                    xInit, yInit, xFin - xInit, yFin - yInit,
                    6, this._colors.fillRubber, this._colors.borderRubber, 2);
            }
        }

        if (dm.showDropPlace && this._selectedList !== null) {
            /* Border strokes batched into one path + one stroke, fills
               reuse a single Graphene.Rect / Gsk.RoundedRect across all
               cells (push_rounded_clip and append_color copy). */
            let borderBuilder = null;
            const fillRect = new Graphene.Rect();
            const roundedRect = new Gsk.RoundedRect();
            for (let [x, y] of this._selectedList) {
                x += elementSpacing;
                y += elementSpacing;
                const width = grid._elementWidth - 2 * elementSpacing;
                const height = grid._elementHeight - 2 * elementSpacing;
                if (borderBuilder === null)
                    borderBuilder = new Gsk.PathBuilder();
                this._appendRoundedRectPath(borderBuilder, x, y, width, height, 10);
                fillRect.init(x, y, width, height);
                roundedRect.init_from_rect(fillRect, Math.min(10, width / 2, height / 2));
                snapshot.push_rounded_clip(roundedRect);
                snapshot.append_color(this._colors.fillDrop, fillRect);
                snapshot.pop();
            }
            if (borderBuilder !== null) {
                snapshot.append_stroke(borderBuilder.to_path(), this._stroke1,
                    this._colors.borderDrop);
            }
        }
    }

    /** Appends one rounded-rect contour to a Gsk path (same geometry as
     *  `_snapshotRoundedRect`'s border branch, batched for one stroke). */
    _appendRoundedRectPath(builder, x, y, width, height, radius) {
        radius = Math.min(radius, width / 2, height / 2);
        builder.move_to(x + radius, y);
        builder.line_to(x + width - radius, y);
        builder.arc_to(x + width, y, x + width, y + radius);
        builder.line_to(x + width, y + height - radius);
        builder.arc_to(x + width, y + height, x + width - radius, y + height);
        builder.line_to(x + radius, y + height);
        builder.arc_to(x, y + height, x, y + height - radius);
        builder.line_to(x, y + radius);
        builder.arc_to(x, y, x + radius, y);
        builder.close();
    }

    _snapshotRoundedRect(snapshot, x, y, width, height, radius, fillColor, borderColor, borderWidth) {
        if (width < 0) {
            x += width;
            width = -width;
        }
        if (height < 0) {
            y += height;
            height = -height;
        }
        radius = Math.min(radius, width / 2, height / 2);

        if (fillColor) {
            const rect = new Graphene.Rect();
            rect.init(x, y, width, height);
            const roundedRect = new Gsk.RoundedRect();
            roundedRect.init_from_rect(rect, radius);
            snapshot.push_rounded_clip(roundedRect);
            snapshot.append_color(fillColor, rect);
            snapshot.pop();
        }

        if (borderWidth) {
            const builder = new Gsk.PathBuilder();
            this._appendRoundedRectPath(builder, x, y, width, height, radius);
            const stroke = borderWidth === 1 ? this._stroke1
                : borderWidth === 2 ? this._stroke2 : new Gsk.Stroke(borderWidth);
            snapshot.append_stroke(builder.to_path(), stroke, borderColor);
        }
    }
};
