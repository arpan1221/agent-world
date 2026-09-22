// Swappable branding. Nothing in the framework hardcodes a product or employer
// name: the display brand and the orchestration-pipeline label are read from the
// environment, defaulting to neutral, agnostic values. Set AGENT_WORLD_BRAND to
// re-label the UI for your own deployment.
const clean = (value, fallback) => {
  const text = String(value ?? '').trim();
  return text && text.length <= 60 ? text : fallback;
};

export const BRAND = Object.freeze({
  // Product name shown in the control room and world view.
  name: clean(process.env.AGENT_WORLD_BRAND, 'Agent World'),
  // Human label for the verified SDLC orchestration surface.
  pipeline: clean(process.env.AGENT_WORLD_PIPELINE_LABEL, 'SDLC'),
});
