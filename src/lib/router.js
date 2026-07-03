'use strict';
// Tiny express-style router: pattern paths with :params.

class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, ...handlers) {
    const keys = [];
    const regexStr = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex specials (not ':' or '*')
      .replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      })
      .replace(/\*/g, '.*');
    const regex = new RegExp('^' + regexStr + '/?$');
    this.routes.push({ method, regex, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handlers: route.handlers, params };
    }
    return null;
  }
}

module.exports = { Router };
