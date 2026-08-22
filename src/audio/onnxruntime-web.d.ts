// The onnxruntime-web package (dev build pinned to the transformers.js
// version) ships types.d.ts outside its exports map, so a plain package import
// cannot resolve them. Importing the declaration file registers its ambient
// `declare module 'onnxruntime-web'` block.
import '../../node_modules/onnxruntime-web/types';
