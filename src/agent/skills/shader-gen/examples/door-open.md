---
tags: 3d, door, open, split, swing, hinge
description: Door open transition — outgoing splits into two halves that swing open like doors, revealing incoming behind.
complexity: high
---

# Door Open Transition

Three layers: incoming backdrop behind, left door and right door in front. Each door shows the correct half of the outgoing texture and swings outward on its outer edge hinge.

Key decisions:

- **Camera distance from FOV**: `dist = 1 / Math.tan(fovRad / 2)` ensures height=2 plane fills viewport. No hardcoded camera z.
- **UV remapping for split texture**: Left door UVs remapped to u:[0, 0.5], right door to u:[0.5, 1]. Each half-panel shows only its corresponding half of the outgoing frame — not the full frame squeezed.
- **Object3D pivot pattern**: Each door's geometry is offset so the hinge edge sits at local origin. The Object3D parent is positioned at the screen edge. Rotating the Object3D swings the door around the correct hinge. Left hinge at x=-W/2, right hinge at x=+W/2.
- **Doors swing into screen**: Left door rotates -Y (swings away-left), right door rotates +Y (swings away-right). Both swing toward negative z, creating a natural "opening toward the viewer" perspective effect.

```typescript
class DoorOpenTransition extends TransitionProcessor {
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private leftPivot!: Object3D;
  private rightPivot!: Object3D;
  private leftMat!: MeshBasicMaterial;
  private rightMat!: MeshBasicMaterial;
  private backMat!: MeshBasicMaterial;

  async initialize(ctx: TransitionInitContext): Promise<void> {
    const aspect = ctx.width / ctx.height;
    const fov = 50;
    const dist = 1 / Math.tan((fov * Math.PI) / 180 / 2);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(fov, aspect, 0.01, 100);
    this.camera.position.z = dist;

    const W = 2 * aspect;
    const H = 2;

    // Backdrop: incoming clip, full width
    this.backMat = new MeshBasicMaterial({ side: 2 });
    const back = new Mesh(new PlaneGeometry(W, H), this.backMat);
    back.position.z = -0.05;
    this.scene.add(back);

    // Left door: shows LEFT half of outgoing (UV u: 0→0.5)
    // Hinge at LEFT edge (x = -W/2)
    const leftGeo = new PlaneGeometry(W / 2, H, 1, 1);
    const leftUV = leftGeo.attributes.uv;
    for (let i = 0; i < leftUV.count; i++) {
      leftUV.setX(i, leftUV.getX(i) * 0.5);
    }
    leftUV.needsUpdate = true;
    this.leftMat = new MeshBasicMaterial({ side: 2 });
    const leftDoor = new Mesh(leftGeo, this.leftMat);
    // Shift geometry so LEFT edge is at local origin (pivot)
    leftDoor.geometry.translate(W / 4, 0, 0);
    this.leftPivot = new Object3D();
    this.leftPivot.position.x = -W / 2;
    this.leftPivot.add(leftDoor);
    this.scene.add(this.leftPivot);

    // Right door: shows RIGHT half of outgoing (UV u: 0.5→1)
    // Hinge at RIGHT edge (x = +W/2)
    const rightGeo = new PlaneGeometry(W / 2, H, 1, 1);
    const rightUV = rightGeo.attributes.uv;
    for (let i = 0; i < rightUV.count; i++) {
      rightUV.setX(i, 0.5 + rightUV.getX(i) * 0.5);
    }
    rightUV.needsUpdate = true;
    this.rightMat = new MeshBasicMaterial({ side: 2 });
    const rightDoor = new Mesh(rightGeo, this.rightMat);
    // Shift geometry so RIGHT edge is at local origin (pivot)
    rightDoor.geometry.translate(-W / 4, 0, 0);
    this.rightPivot = new Object3D();
    this.rightPivot.position.x = W / 2;
    this.rightPivot.add(rightDoor);
    this.scene.add(this.rightPivot);
  }

  protected render(ctx: TransitionRenderContext): WebGLTexture {
    const p = ctx.progress;
    const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;

    this.backMat.map = ctx.three.wrapTexture(ctx.incomingTexture);
    this.leftMat.map = ctx.three.wrapTexture(ctx.outgoingTexture);
    this.rightMat.map = ctx.three.wrapTexture(ctx.outgoingTexture);

    // Left door: hinge on left, swings into screen (negative Y rotation)
    this.leftPivot.rotation.y = -eased * (Math.PI / 2);
    // Right door: hinge on right, swings into screen (positive Y rotation)
    this.rightPivot.rotation.y = eased * (Math.PI / 2);

    return ctx.threePass(this.scene, this.camera);
  }
}
```
