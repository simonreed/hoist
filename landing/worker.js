// Cloudflare Worker for hoist.sh
// Serves install.sh to curl/wget, HTML landing page to browsers.

import INSTALL_SH from "./install.sh";
import INDEX_HTML from "./index.html";

export default {
  async fetch(request) {
    const ua = request.headers.get("user-agent") || "";
    const isCli = /curl|wget|fetch/i.test(ua);

    if (isCli) {
      return new Response(INSTALL_SH, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    }

    return new Response(INDEX_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  },
};
