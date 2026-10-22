/**
 * Camera Viewport Engine
 * Handles 2D transformations between Screen Space (DOM pixels) and World Space (virtual canvas).
 */

export class Camera {
  constructor(x = 0, y = 0, zoom = 1.0, minZoom = 0.05, maxZoom = 20.0) {
    this.x = x;
    this.y = y;
    this.zoom = zoom;
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
  }

  screenToWorld(screenX, screenY) {
    return {
      x: (screenX - this.x) / this.zoom,
      y: (screenY - this.y) / this.zoom
    };
  }

  worldToScreen(worldX, worldY) {
    return {
      x: worldX * this.zoom + this.x,
      y: worldY * this.zoom + this.y
    };
  }

  pan(dx, dy) {
    this.x += dx;
    this.y += dy;
  }

  zoomAt(factor, screenX, screenY) {
    const nextZoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    if (nextZoom === this.zoom) return;

    // Anchor point: Keep the world coordinate under the cursor stationary
    const world = this.screenToWorld(screenX, screenY);
    this.zoom = nextZoom;
    this.x = screenX - world.x * this.zoom;
    this.y = screenY - world.y * this.zoom;
  }

  reset(width, height) {
    this.x = width / 2;
    this.y = height / 2;
    this.zoom = 1.0;
  }

  fitToArtboard(artboard, screenWidth, screenHeight, padding = 60) {
    const availW = Math.max(100, screenWidth - padding * 2);
    const availH = Math.max(100, screenHeight - padding * 2);
    const scaleX = availW / artboard.width;
    const scaleY = availH / artboard.height;
    const targetZoom = Math.min(scaleX, scaleY, 2.0);

    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, targetZoom));
    // Center the artboard (artboard is from -w/2, -h/2 to +w/2, +h/2)
    this.x = screenWidth / 2;
    this.y = screenHeight / 2;
  }
}
