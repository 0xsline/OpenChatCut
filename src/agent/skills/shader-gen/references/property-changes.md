# Shader Property Changes

Read this whenever a task touches editable shader properties: adding, renaming, or removing a property key; changing a default; promoting a hardcoded shader constant; or updating one applied effect/transition override.

## Data Model

Three layers, in strict order:

1. `asset.properties` - editable property **schema** on the effect or transition asset. Declares every key (type, label, default, and `min`/`max`/`step` or `options`). Source of truth.
2. `item.propertyOverrides` - per-applied-item overrides. Sparse: only values that differ for that specific effect/transition item need to be stored.
3. `ctx.properties` - runtime object passed into the shader processor. Built by merging schema defaults with the applied item's overrides.

Shader property types are: `number`, `boolean`, `color`, `select`, `vec2`. Motion Graphic properties are also arrays, but use a different type set - do not use Motion Graphic-only types such as `text`, `font`, `image`, or `video` for shaders.

**Prerequisite rule:** a key must exist in `asset.properties` before shader code should read `ctx.properties.key`, and before an applied item override can show a control for that key.

For shader assets, `asset.properties` is always an array. Each object inside the array is one editable property entry.

## Decision Table

Use `edit_asset` when:

- shader code starts reading a new `ctx.properties.key`
- a property key is added, renamed, or removed
- a property type, label, options, or default changes

Use an applied item update with `propertyOverrides` when:

- the key already exists on the effect/transition asset
- one applied effect/transition item should use a different value than the asset default

Do not use `propertyOverrides` to add schema. Do not use `edit_asset` for one-off instance values.

## Promoting Hardcoded Values to Properties

When the user asks to adjust a hardcoded shader value (intensity, radius, color, softness, direction, center point, or anything tweakable), in the same turn both make the shader change AND promote the value to a property. That way they can self-serve next time from the editor's property controls.

Skip promotion when:

- user explicitly frames it as one-off ("just this once", "only for this item")
- the value is structural: texture binding names, pass IDs, GLSL constants required for loop unrolling, or math tied to shader correctness
- the asset is a locked template the user doesn't own

Workflow (one turn):

1. Fetch the current shader asset code and properties
2. Locate the hardcoded literal
3. Replace it with `ctx.properties.<key>` plus a fallback to the current value so existing items render identically
4. Add a matching entry inside the `properties` array with sensible `min`/`max`/`step` or `options`
5. `edit_asset` with both the updated `code` and `properties` in one call
6. If the user also asked for a specific new value, apply it either as the new `defaultValue` (baseline) or as a `propertyOverride` on the specific applied item

Example - promoting an intensity constant:

```ts
const props = ctx.properties as { intensity?: number } | undefined;
const intensity = props?.intensity ?? 0.6;
```

```json
"properties": [
  {
    "key": "intensity",
    "label": "Intensity",
    "type": "number",
    "defaultValue": 0.6,
    "min": 0,
    "max": 1,
    "step": 0.01
  }
]
```

Example - promoting a center point:

```json
"properties": [
  {
    "key": "center",
    "label": "Center",
    "type": "vec2",
    "defaultValue": [0.5, 0.5]
  }
]
```

## Asset-Level Changes

When the schema changes, update the shader asset's `code` and `properties` in the same `edit_asset` call. Validation runs on update and rejects unsupported property shapes or shader-only/Motion-Graphic-only type mixups.

1. Fetch the current asset with code and properties
2. Update code to read the target key from `ctx.properties`
3. `edit_asset` with both the new `properties` array and the new `code`
4. If a key was renamed, migrate affected applied item overrides to the new key

Keep keys stable when possible - renames create migration work.

## Item-Level Changes

Prerequisite: the key must already exist on `asset.properties`. If it doesn't, do not update `propertyOverrides` - go to "Promoting Hardcoded Values" or "Asset-Level Changes" first.

Update only the applied effect/transition item whose value should differ from the asset default.

```json
{ "propertyOverrides": { "intensity": 0.8 } }
```

```json
{ "propertyOverrides": { "center": [0.45, 0.55] } }
```
