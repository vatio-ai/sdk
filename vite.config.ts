import { defineConfig } from "vite";

// Builds the npm package: `@vatio-ai/sdk`, one ES module in dist/, with
// dist/index.d.ts emitted alongside it by tsconfig.build.json (see the
// `build` script -- vite does not emit declarations and this package has no
// plugin dependency that would make it).
//
// It used to build to backend/public/v1/sdk.js and ship from cdn.vatio.ai, loaded by
// a dynamic import() the bundler could not see. Two things ended that: the
// widget bundles the SDK now, so nothing fetches it at runtime, and a package
// on npm is a better contract than a URL -- the version is a range in the
// consumer's package.json instead of a directory Vatio maintains forever.
//
// No build stamp banner here, unlike widget/inbox. That stamp answers "which
// build is the CDN edge holding?", a question a published tarball does not
// have: its version is its identity.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Nothing to externalize -- the SDK has no dependencies, which is what
    // lets a page with no bundler load it straight from an npm CDN.
    //
    // One entry. There were two: src/inbox.ts was the client behind Vatio's
    // own inbox panel, kept out of index.ts because widget.js bundles
    // whatever index.ts pulls in and is pasted into other people's pages,
    // where a supervisor API has no business being. The panel is gone -- the
    // inbox is a site on its own origin and speaks to Api::Supervisor::V1
    // with a token -- so the file, the ./inbox export and the assertion in
    // sdk-publish.yml that policed the boundary all went with it (3.0.0).
    lib: {
      entry: { index: "src/index.ts" },
      formats: ["es"],
    },
    // Stable chunk name. The default carries a content hash, which is right
    // for a CDN and pointless in a tarball whose identity is its version --
    // and it renames a published file on every build. Nothing is split out
    // of one entry, but the setting costs nothing and outlives the reason.
    rollupOptions: {
      output: { chunkFileNames: "[name].js" },
    },
  },
});
