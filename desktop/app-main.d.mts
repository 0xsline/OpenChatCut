// desktop:build:main emits two bundles into desktop-dist/: the entry
// (bootstrap.ts -> main.mjs) and the application (main.ts -> app-main.mjs).
// bootstrap.ts imports the second one dynamically, by a specifier marked
// external, so that a failure to resolve the application's own dependencies is
// a catchable rejection instead of an abort with no window and no dialog.
// No source module lives at this path; this declaration is what lets the type
// checker see the file the build emits.
export {};
