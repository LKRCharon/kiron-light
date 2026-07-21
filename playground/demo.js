const colors = ["blue", "teal", "orange"];
const config = {
  retries: 3,
  enabled: true,
  fallback: null,
};

function renderBadge(label) {
  return `${label}\t${JSON.stringify(config)}`;
}

console.log(renderBadge(colors.at(1)));
