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
'use strict';
const Gtk = imports.gi.Gtk;
const Gdk = imports.gi.Gdk;
const Gsk = imports.gi.Gsk;
const Graphene = imports.gi.Graphene;
const GObject = imports.gi.GObject;

const elementSpacing = 2;

var PaintContainer = class PaintContainer extends Gtk.Widget {
    static {
        GObject.registerClass(this);
    }

    constructor(desktopGrid) {
        super();
        this._desktopGrid = desktopGrid;
        this._selectedList = null;
        this._width = 0;
        this._height = 0;
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

        if (dm.rubberBand && dm.selectionRectangle) {
            if (grid.gridGlobalRectangle.intersect(dm.selectionRectangle)[0]) {
                let [xInit, yInit] = grid.coordinatesGlobalToLocal(dm.x1, dm.y1);
                let [xFin, yFin] = grid.coordinatesGlobalToLocal(dm.x2, dm.y2);

                const fillColor = new Gdk.RGBA();
                fillColor.red = dm.selectColor.red;
                fillColor.green = dm.selectColor.green;
                fillColor.blue = dm.selectColor.blue;
                fillColor.alpha = 0.3;

                const borderColor = new Gdk.RGBA();
                borderColor.red = dm.selectColor.red;
                borderColor.green = dm.selectColor.green;
                borderColor.blue = dm.selectColor.blue;
                borderColor.alpha = 1.0;

                this._snapshotRoundedRect(snapshot,
                    xInit, yInit, xFin - xInit, yFin - yInit,
                    5, fillColor, borderColor, 1);
            }
        }

        if (dm.showDropPlace && this._selectedList !== null) {
            for (let [x, y] of this._selectedList) {
                const fillColor = new Gdk.RGBA();
                fillColor.red = dm.selectColor.red;
                fillColor.green = dm.selectColor.green;
                fillColor.blue = dm.selectColor.blue;
                fillColor.alpha = 0.4;

                const borderColor = new Gdk.RGBA();
                borderColor.red = dm.selectColor.red;
                borderColor.green = dm.selectColor.green;
                borderColor.blue = dm.selectColor.blue;
                borderColor.alpha = 1.0;

                this._snapshotRoundedRect(snapshot,
                    x + elementSpacing, y + elementSpacing,
                    grid._elementWidth - 2 * elementSpacing,
                    grid._elementHeight - 2 * elementSpacing,
                    10, fillColor, borderColor, 0.5);
            }
        }
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

        const rect = new Graphene.Rect();
        rect.init(x, y, width, height);

        const roundedRect = new Gsk.RoundedRect();
        roundedRect.init_from_rect(rect, radius);

        snapshot.push_rounded_clip(roundedRect);
        snapshot.append_color(fillColor, rect);
        snapshot.pop();

        if (borderWidth) {
            const stroke = new Gsk.Stroke(borderWidth);
            const builder = new Gsk.PathBuilder();
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
            snapshot.append_stroke(builder.to_path(), stroke, borderColor);
        }
    }
};
