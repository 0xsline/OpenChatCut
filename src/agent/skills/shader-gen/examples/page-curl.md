---
tags: 3d, page, curl, flip, turn, book, peel
description: Page curl transition — outgoing page curls away from left to right, revealing incoming underneath.
complexity: high
---

# Page Curl Transition

Two-layer approach: incoming page sits flat behind (z=-0.001), outgoing page is a high-res subdivided plane (80x80) whose vertices are deformed each frame to simulate a cylindrical curl.

Key decisions:

- **Camera distance from FOV**: `dist = 1 / Math.tan(fovRad / 2)` ensures the plane (height=2) exactly fills the viewport vertically. No hardcoded camera z.
- **Radius proportional to page width**: `radius = W * 0.08` scales with aspect ratio, preventing the curl from being too tight on wide videos or too loose on tall ones.
- **Fold sweeps left→right**: `foldX = -W/2 + eased * (W + radius * PI)`. At progress=0 fold is at left edge (nothing curled), at progress=1 it's past the right edge (fully curled away).
- **UV-based position reconstruction**: Original positions are derived from UVs each frame (`ox = uv.getX(i) * W - W/2`), since the position buffer gets overwritten. UVs are immutable.
- **Three curl zones**: (1) `ox <= foldX` → flat, not yet reached. (2) `ox > foldX, angle <= PI` → wrapping around cylinder. (3) `angle > PI` → past 180°, extends flat at z=2\*radius back toward -x (folded-back page visible on top).
- **`side: 2` (DoubleSide)**: Back of the curling page is visible during the curl.
- **Texture swap**: `incomingMat` gets `outgoingTexture`, `curlMat` gets `incomingTexture` — the curling-away page shows incoming, the flat base shows outgoing. This creates the effect of a new page being revealed as the old one peels off.

```typescript
export class PageCurlTransition extends TransitionProcessor {
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private curlMesh!: Mesh;
  private incomingMesh!: Mesh;
  private curlMat!: MeshBasicMaterial;
  private incomingMat!: MeshBasicMaterial;
  private aspect!: number;
  private W!: number;

  async initialize(ctx: TransitionInitContext): Promise<void> {
    this.aspect = ctx.width / ctx.height;
    this.scene = new Scene();

    const fov = 45;
    const fovRad = (fov * Math.PI) / 180;
    const dist = 1 / Math.tan(fovRad / 2);

    this.camera = new PerspectiveCamera(fov, this.aspect, 0.01, 100);
    this.camera.position.z = dist;

    this.W = 2 * this.aspect;
    const H = 2;

    this.incomingMat = new MeshBasicMaterial({ side: 2 });
    this.incomingMesh = new Mesh(
      new PlaneGeometry(this.W, H),
      this.incomingMat,
    );
    this.incomingMesh.position.z = -0.001;
    this.scene.add(this.incomingMesh);

    this.curlMat = new MeshBasicMaterial({ side: 2 });
    this.curlMesh = new Mesh(
      new PlaneGeometry(this.W, H, 80, 80),
      this.curlMat,
    );
    this.scene.add(this.curlMesh);
  }

  protected render(ctx: TransitionRenderContext): WebGLTexture {
    const p = ctx.progress;
    const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;

    this.incomingMat.map = ctx.three.wrapTexture(ctx.outgoingTexture);
    this.curlMat.map = ctx.three.wrapTexture(ctx.incomingTexture);

    const W = this.W;
    const radius = W * 0.08;
    const foldX = -W / 2 + eased * (W + radius * Math.PI);

    const pos = this.curlMesh.geometry.attributes.position;
    const uv = this.curlMesh.geometry.attributes.uv;
    const count = pos.count;

    for (let i = 0; i < count; i++) {
      const ox = uv.getX(i) * W - W / 2;
      const oy = uv.getY(i) * 2 - 1;

      let nx: number, nz: number;

      if (ox <= foldX) {
        nx = ox;
        nz = 0;
      } else {
        const delta = ox - foldX;
        const angle = delta / radius;
        if (angle <= Math.PI) {
          nx = foldX + radius * Math.sin(angle);
          nz = radius * (1 - Math.cos(angle));
        } else {
          const extra = delta - radius * Math.PI;
          nx = foldX - extra;
          nz = radius * 2;
        }
      }

      pos.setXYZ(i, nx, oy, nz);
    }

    pos.needsUpdate = true;
    this.curlMesh.geometry.computeVertexNormals();

    return ctx.threePass(this.scene, this.camera);
  }
}
```
