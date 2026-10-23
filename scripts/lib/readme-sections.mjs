// The personal fork has its own landing section; translations track the upstream body.
export function upstreamReadme(content) {
  const start = "<!-- PERSONAL-REA:START -->";
  const end = "<!-- PERSONAL-REA:END -->";
  if (!content.includes(start) && !content.includes(end)) return content;
  if (
    !content.startsWith(start) ||
    content.split(start).length !== 2 ||
    content.split(end).length !== 2
  )
    throw new Error("Malformed personal README section boundaries");
  return content.slice(content.indexOf(end) + end.length).trimStart();
}
