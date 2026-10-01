# @vatio-ai/sdk

Talk to a [Vatio](https://vatio.ai) agent from the browser. No dependencies,
one ES module, TypeScript types included.

You do not need this to put an agent on a page — that is the widget, one
`<script>` tag, and it already contains this SDK. Reach for the SDK when you
are building the interface yourself.

```sh
npm install @vatio-ai/sdk
```

```js
import { Vatio } from "@vatio-ai/sdk";

const chat = await Vatio.chat({ workspace: "acme", token: "vatpub_..." });

chat.on("message", (message) => render(message));
chat.on("typing", (isTyping) => showDots(isTyping));

await chat.send("hola");
```

No bundler? Any npm CDN serves the same module:

```html
<script type="module">
  import { Vatio } from "https://cdn.jsdelivr.net/npm/@vatio-ai/sdk/+esm";
</script>
```

`token` is a **publishable** token (`vatpub_…`). It is meant to be in your
page source: it can start a conversation on one workspace and nothing else,
and only from an origin you allowlisted under Settings → Widget. A `vat_`
token is a developer secret and must never reach a browser.

Full reference: <https://vatio.ai/docs#building-your-own-chat-ui>.

## `@vatio-ai/sdk/inbox` is gone (3.0.0)

There used to be a second entry point: the client behind Vatio's own inbox
panel, same-origin and authorized by a session cookie, useful only on a page
Vatio served. The panel is gone — the inbox is a site of its own now
(`inbox/`), on another origin, talking to `Api::Supervisor::V1` with a bearer
token it holds itself. So the client moved into that app, and this package
went back to one entry point.

Nothing replaced it here, deliberately. A supervisor API is not something to
paste into a visitor's page, which is what this package is for: everything
`src/index.ts` pulls in ends up inside `widget.js`. `sdk-publish.yml` used to
police that boundary between the two entries and now just checks there is one.

If you were importing it: you were not supposed to be able to, and it would
have answered 401 from your domain. The conversations API for your own product
is not this — ask, and it can be a real one.

## Versions

Semver, and `VERSION` (exported from the module) matches the release on npm. A
breaking change to the module's surface is a new major version.

## Issues

Bugs and questions go to [issues](https://github.com/vatio-ai/sdk/issues).
This repository is a read-only mirror of the SDK as it ships inside Vatio, so
a pull request cannot be merged here: open an issue describing the change
instead.
