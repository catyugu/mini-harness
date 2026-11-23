export default function setup(_ctx, api) {
  api.provide('exampleGreeting', { greet: (name) => api.config.prefix + ', ' + name });
}
