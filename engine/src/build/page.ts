/**
 * The page is static: all data comes from `geometry.json` and `nav.json`,
 * so a built scene is a plain directory any static server can hand out.
 * The empty favicon keeps the console clean (a 404 would be an error).
 */
export function indexHtml(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<&]/g, "")}</title>
<link rel="icon" href="data:,">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}canvas{display:block}</style>
</head>
<body>
<script type="module" src="runtime.js"></script>
</body>
</html>
`;
}
