const staticRequest = (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/') url.pathname = '/index.html';
  return new Request(url.toString(), request);
};

export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(staticRequest(request));
  },
};
