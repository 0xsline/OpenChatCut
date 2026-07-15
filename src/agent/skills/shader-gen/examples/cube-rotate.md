---
tags: 3d, cube, rotate, box, spin
description: 3D cube rotation — outgoing on front face, incoming on right face, rotates 90° around Y axis.
complexity: high
---

# Cube Rotate Transition

Uses BoxGeometry with per-face materials. Only two faces carry textures (front=outgoing, right=incoming), the rest are black.

Key decisions:

- `BoxGeometry(1.5 * aspect, 1.5, 1.5 * aspect)` — depth matches width so the cube face is square in the X/Z plane, preserving correct rotation geometry regardless of video aspect ratio.
- `camera.position.z = 2.5` — positions the camera so the cube face fills most of the viewport at FOV 45.
- Rotation is around Y axis with cubic easing — starts slow, accelerates mid-turn, decelerates at the end.

```typescript
class CubeTransition extends TransitionProcessor {
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private cube!: Mesh;
  private outMat!: MeshBasicMaterial;
  private inMat!: MeshBasicMaterial;

  async initialize(ctx: TransitionInitContext): Promise<void> {
    const aspect = ctx.width / ctx.height;
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(45, aspect, 0.1, 1000);
    this.camera.position.z = 2.5;

    const geometry = new BoxGeometry(1.5 * aspect, 1.5, 1.5 * aspect);
    this.outMat = new MeshBasicMaterial();
    this.inMat = new MeshBasicMaterial();

    // Front face (index 4) and Right face (index 0)
    const materials = [
      this.inMat,
      new MeshBasicMaterial({ color: 0x000000 }),
      new MeshBasicMaterial({ color: 0x000000 }),
      new MeshBasicMaterial({ color: 0x000000 }),
      this.outMat,
      new MeshBasicMaterial({ color: 0x000000 }),
    ];
    this.cube = new Mesh(geometry, materials);
    this.scene.add(this.cube);
  }

  protected render(ctx: TransitionRenderContext): WebGLTexture {
    this.outMat.map = ctx.three.wrapTexture(ctx.outgoingTexture);
    this.inMat.map = ctx.three.wrapTexture(ctx.incomingTexture);

    // Cubic easing
    const p = ctx.progress;
    const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    this.cube.rotation.y = -eased * (Math.PI / 2);

    return ctx.threePass(this.scene, this.camera);
  }
}
```
