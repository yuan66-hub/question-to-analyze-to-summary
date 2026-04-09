# 前端常用设计模式

> 系统梳理前端开发中最常用的设计模式，覆盖创建型、结构型、行为型三大类，结合 React/Vue/Node.js 等实际场景给出示例代码。

---

## 目录

1. [总览：前端高频设计模式](#1-总览前端高频设计模式)
2. [创建型模式](#2-创建型模式)
   - 2.1 [单例模式（Singleton）](#21-单例模式singleton)
   - 2.2 [工厂模式（Factory）](#22-工厂模式factory)
   - 2.3 [建造者模式（Builder）](#23-建造者模式builder)
3. [结构型模式](#3-结构型模式)
   - 3.1 [代理模式（Proxy）](#31-代理模式proxy)
   - 3.2 [装饰器模式（Decorator）](#32-装饰器模式decorator)
   - 3.3 [适配器模式（Adapter）](#33-适配器模式adapter)
   - 3.4 [外观模式（Facade）](#34-外观模式facade)
   - 3.5 [组合模式（Composite）](#35-组合模式composite)
4. [行为型模式](#4-行为型模式)
   - 4.1 [观察者模式（Observer）](#41-观察者模式observer)
   - 4.2 [发布-订阅模式（Pub/Sub）](#42-发布-订阅模式pubsub)
   - 4.3 [策略模式（Strategy）](#43-策略模式strategy)
   - 4.4 [命令模式（Command）](#44-命令模式command)
   - 4.5 [迭代器模式（Iterator）](#45-迭代器模式iterator)
   - 4.6 [状态模式（State）](#46-状态模式state)
   - 4.7 [中介者模式（Mediator）](#47-中介者模式mediator)
   - 4.8 [责任链模式（Chain of Responsibility）](#48-责任链模式chain-of-responsibility)
5. [前端专属模式](#5-前端专属模式)
   - 5.1 [模块模式（Module）](#51-模块模式module)
   - 5.2 [Mixin 模式](#52-mixin-模式)
   - 5.3 [HOC / Render Props / Hooks 模式](#53-hoc--render-props--hooks-模式)
6. [模式选型速查表](#6-模式选型速查表)
7. [面试高频问题](#7-面试高频问题)

---

## 1. 总览：前端高频设计模式

```
分类          模式                   前端典型场景
─────────────────────────────────────────────────────────────
创建型        单例                   全局状态管理、弹窗实例、日志服务
              工厂                   组件工厂、图表创建、跨平台适配
              建造者                 复杂配置对象、请求构造器

结构型        代理                   响应式数据（Vue 3）、懒加载、缓存代理
              装饰器                 HOC、日志增强、权限校验
              适配器                 第三方 SDK 封装、API 版本兼容
              外观                   统一 API 封装（axios）、浏览器兼容层
              组合                   虚拟 DOM 树、文件树、菜单组件

行为型        观察者                 DOM 事件、Vue 响应式、RxJS
              发布-订阅              EventBus、Redux、WebSocket 消息分发
              策略                   表单校验、排序算法、支付方式
              命令                   撤销/重做、宏录制、快捷键系统
              迭代器                 for...of、自定义遍历、分页加载
              状态                   有限状态机（XState）、流程引擎
              中介者                 Vuex/Redux Store、聊天室
              责任链                 中间件（Koa/Express）、拦截器链
```

---

## 2. 创建型模式

### 2.1 单例模式（Singleton）

**核心思想**：保证一个类仅有一个实例，并提供全局访问点。

**应用场景**：
- 全局状态管理（Store）
- 全局弹窗/通知管理器
- 数据库连接池
- 日志服务
- 浏览器中的 `window`、`document`

```typescript
// ===== 基础单例 =====
class Logger {
  private static instance: Logger;
  private logs: string[] = [];

  private constructor() {} // 私有构造函数

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  log(message: string) {
    this.logs.push(`[${new Date().toISOString()}] ${message}`);
    console.log(message);
  }

  getLogs() {
    return [...this.logs];
  }
}

// 使用
const logger1 = Logger.getInstance();
const logger2 = Logger.getInstance();
console.log(logger1 === logger2); // true
```

```typescript
// ===== ES Module 天然单例 =====
// store.ts — 模块级别变量天然是单例
let state = { count: 0, user: null };

export const getState = () => state;
export const setState = (partial: Partial<typeof state>) => {
  state = { ...state, ...partial };
};

// a.ts 和 b.ts 导入的都是同一个 state
```

```typescript
// ===== 全局弹窗管理器 =====
class ModalManager {
  private static instance: ModalManager;
  private modalStack: string[] = [];

  private constructor() {}

  static getInstance() {
    return (this.instance ??= new ModalManager());
  }

  open(modalId: string) {
    this.modalStack.push(modalId);
    // 渲染弹窗逻辑...
  }

  close() {
    const modalId = this.modalStack.pop();
    // 关闭弹窗逻辑...
    return modalId;
  }

  get current() {
    return this.modalStack.at(-1) ?? null;
  }
}
```

---

### 2.2 工厂模式（Factory）

**核心思想**：定义创建对象的接口，让子类或配置决定实例化哪个类，将创建逻辑与使用逻辑解耦。

**应用场景**：
- 根据类型动态创建组件（图表、表单控件）
- 跨平台 UI 组件（Web / React Native）
- 消息通知创建（success / error / warning）

```typescript
// ===== 简单工厂：图表创建 =====
interface Chart {
  render(container: HTMLElement): void;
}

class BarChart implements Chart {
  render(container: HTMLElement) {
    container.innerHTML = '<div class="bar-chart">柱状图</div>';
  }
}

class LineChart implements Chart {
  render(container: HTMLElement) {
    container.innerHTML = '<div class="line-chart">折线图</div>';
  }
}

class PieChart implements Chart {
  render(container: HTMLElement) {
    container.innerHTML = '<div class="pie-chart">饼图</div>';
  }
}

// 简单工厂
function createChart(type: 'bar' | 'line' | 'pie'): Chart {
  const charts = {
    bar: BarChart,
    line: LineChart,
    pie: PieChart,
  };
  const ChartClass = charts[type];
  if (!ChartClass) throw new Error(`Unknown chart type: ${type}`);
  return new ChartClass();
}

// 使用
const chart = createChart('bar');
chart.render(document.getElementById('container')!);
```

```typescript
// ===== 抽象工厂：跨平台组件 =====
interface Button {
  render(): string;
}
interface Input {
  render(): string;
}

// Web 平台
class WebButton implements Button {
  render() { return '<button class="web-btn">Click</button>'; }
}
class WebInput implements Input {
  render() { return '<input class="web-input" />'; }
}

// Mobile 平台
class MobileButton implements Button {
  render() { return '<TouchableOpacity>Click</TouchableOpacity>'; }
}
class MobileInput implements Input {
  render() { return '<TextInput />'; }
}

// 抽象工厂
interface UIFactory {
  createButton(): Button;
  createInput(): Input;
}

class WebUIFactory implements UIFactory {
  createButton() { return new WebButton(); }
  createInput() { return new WebInput(); }
}

class MobileUIFactory implements UIFactory {
  createButton() { return new MobileButton(); }
  createInput() { return new MobileInput(); }
}

// 使用 — 客户端代码不依赖具体平台
function renderForm(factory: UIFactory) {
  const button = factory.createButton();
  const input = factory.createInput();
  return `${input.render()} ${button.render()}`;
}

const factory = navigator.userAgent.includes('Mobile')
  ? new MobileUIFactory()
  : new WebUIFactory();
renderForm(factory);
```

---

### 2.3 建造者模式（Builder）

**核心思想**：将复杂对象的构建与表示分离，支持链式调用逐步构建。

**应用场景**：
- HTTP 请求构造器
- 复杂配置对象（webpack config、查询条件）
- 表单构建器

```typescript
// ===== 请求构造器 =====
class RequestBuilder {
  private config: RequestInit & { url: string; params: Record<string, string> } = {
    url: '',
    method: 'GET',
    headers: {},
    params: {},
  };

  setUrl(url: string) {
    this.config.url = url;
    return this;
  }

  setMethod(method: string) {
    this.config.method = method;
    return this;
  }

  setHeader(key: string, value: string) {
    (this.config.headers as Record<string, string>)[key] = value;
    return this;
  }

  setParam(key: string, value: string) {
    this.config.params[key] = value;
    return this;
  }

  setBody(body: unknown) {
    this.config.body = JSON.stringify(body);
    this.setHeader('Content-Type', 'application/json');
    return this;
  }

  build(): Request {
    const url = new URL(this.config.url);
    Object.entries(this.config.params).forEach(([k, v]) =>
      url.searchParams.set(k, v)
    );
    return new Request(url.toString(), {
      method: this.config.method,
      headers: this.config.headers,
      body: this.config.body,
    });
  }
}

// 使用 — 链式调用，语义清晰
const request = new RequestBuilder()
  .setUrl('https://api.example.com/users')
  .setMethod('POST')
  .setHeader('Authorization', 'Bearer token123')
  .setBody({ name: 'Alice', age: 30 })
  .build();

fetch(request);
```

```typescript
// ===== 查询条件构造器 =====
class QueryBuilder {
  private conditions: string[] = [];
  private _orderBy = '';
  private _limit = 0;

  where(field: string, op: string, value: unknown) {
    this.conditions.push(`${field} ${op} ${JSON.stringify(value)}`);
    return this;
  }

  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    this._orderBy = `ORDER BY ${field} ${dir.toUpperCase()}`;
    return this;
  }

  limit(n: number) {
    this._limit = n;
    return this;
  }

  build() {
    let sql = 'SELECT *';
    if (this.conditions.length) sql += ` WHERE ${this.conditions.join(' AND ')}`;
    if (this._orderBy) sql += ` ${this._orderBy}`;
    if (this._limit) sql += ` LIMIT ${this._limit}`;
    return sql;
  }
}

const query = new QueryBuilder()
  .where('age', '>', 18)
  .where('status', '=', 'active')
  .orderBy('createdAt', 'desc')
  .limit(10)
  .build();
// SELECT * WHERE age > 18 AND status = "active" ORDER BY createdAt DESC LIMIT 10
```

---

## 3. 结构型模式

### 3.1 代理模式（Proxy）

**核心思想**：为对象提供一个代替品/占位符，以控制对这个对象的访问。

**应用场景**：
- Vue 3 响应式系统（`Proxy` + `Reflect`）
- 图片懒加载
- 缓存代理
- 访问控制 / 参数校验

```typescript
// ===== Vue 3 响应式原理简化版 =====
function reactive<T extends object>(target: T): T {
  const deps = new Map<string | symbol, Set<Function>>();
  let activeEffect: Function | null = null;

  return new Proxy(target, {
    get(obj, key, receiver) {
      // 依赖收集
      if (activeEffect) {
        if (!deps.has(key)) deps.set(key, new Set());
        deps.get(key)!.add(activeEffect);
      }
      return Reflect.get(obj, key, receiver);
    },
    set(obj, key, value, receiver) {
      const result = Reflect.set(obj, key, value, receiver);
      // 触发更新
      deps.get(key)?.forEach(fn => fn());
      return result;
    },
  });
}

// 使用
const state = reactive({ count: 0 });
// 当 state.count 被读取时收集依赖，被赋值时触发更新
```

```typescript
// ===== 缓存代理 =====
function createCacheProxy<T extends (...args: any[]) => any>(fn: T): T {
  const cache = new Map<string, ReturnType<T>>();

  return new Proxy(fn, {
    apply(target, thisArg, args) {
      const key = JSON.stringify(args);
      if (cache.has(key)) {
        console.log('Cache hit:', key);
        return cache.get(key);
      }
      const result = Reflect.apply(target, thisArg, args);
      cache.set(key, result);
      return result;
    },
  }) as T;
}

// 使用
const expensiveCalc = (n: number) => {
  console.log('Computing...');
  return n * n;
};
const cachedCalc = createCacheProxy(expensiveCalc);
cachedCalc(10); // Computing... → 100
cachedCalc(10); // Cache hit → 100
```

```typescript
// ===== 图片懒加载代理 =====
class LazyImage {
  private img: HTMLImageElement;

  constructor(private src: string, placeholder: string) {
    this.img = document.createElement('img');
    this.img.src = placeholder; // 先显示占位图
  }

  mount(container: HTMLElement) {
    container.appendChild(this.img);

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        this.img.src = this.src; // 进入视口后加载真实图片
        observer.disconnect();
      }
    });
    observer.observe(this.img);
  }
}
```

---

### 3.2 装饰器模式（Decorator）

**核心思想**：动态地给对象添加职责，比继承更灵活。

**应用场景**：
- React HOC（高阶组件）
- TypeScript 装饰器（`@log`、`@debounce`）
- 权限校验增强
- 性能监控切面

```typescript
// ===== 函数装饰器：通用工具 =====

// 防抖装饰器
function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return function (this: any, ...args: any[]) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  } as T;
}

// 节流装饰器
function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let last = 0;
  return function (this: any, ...args: any[]) {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn.apply(this, args);
    }
  } as T;
}

// 日志装饰器
function withLog<T extends (...args: any[]) => any>(fn: T, label?: string): T {
  return function (this: any, ...args: any[]) {
    console.log(`[${label ?? fn.name}] called with:`, args);
    const result = fn.apply(this, args);
    console.log(`[${label ?? fn.name}] returned:`, result);
    return result;
  } as T;
}

// 使用
const handleScroll = throttle(() => console.log('scrolling'), 200);
window.addEventListener('scroll', handleScroll);
```

```typescript
// ===== TypeScript 类装饰器 =====

// 方法执行耗时统计
function measure(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor
) {
  const original = descriptor.value;
  descriptor.value = function (...args: any[]) {
    const start = performance.now();
    const result = original.apply(this, args);
    const end = performance.now();
    console.log(`${propertyKey} took ${(end - start).toFixed(2)}ms`);
    return result;
  };
}

class DataProcessor {
  @measure
  processLargeDataset(data: number[]) {
    return data.map(x => x * 2).filter(x => x > 100).sort((a, b) => a - b);
  }
}
```

```tsx
// ===== React HOC（装饰器在 React 中的体现）=====
function withAuth<P extends object>(Component: React.ComponentType<P>) {
  return function AuthenticatedComponent(props: P) {
    const { user, loading } = useAuth();

    if (loading) return <Spinner />;
    if (!user) return <Navigate to="/login" />;

    return <Component {...props} />;
  };
}

// 使用
const ProtectedDashboard = withAuth(Dashboard);
```

---

### 3.3 适配器模式（Adapter）

**核心思想**：将一个类的接口转换为客户端期望的另一个接口，使接口不兼容的类可以协作。

**应用场景**：
- 第三方 SDK 封装（地图、支付）
- API 数据格式转换
- 旧接口兼容新系统
- 不同存储引擎的统一接口

```typescript
// ===== 存储适配器 =====
interface Storage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

// 适配 localStorage
class LocalStorageAdapter implements Storage {
  async get(key: string) {
    return localStorage.getItem(key);
  }
  async set(key: string, value: string) {
    localStorage.setItem(key, value);
  }
  async remove(key: string) {
    localStorage.removeItem(key);
  }
}

// 适配 IndexedDB
class IndexedDBAdapter implements Storage {
  private dbPromise: Promise<IDBDatabase>;

  constructor(dbName: string) {
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(key: string) {
    const db = await this.dbPromise;
    return new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async set(key: string, value: string) {
    const db = await this.dbPromise;
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
  }

  async remove(key: string) {
    const db = await this.dbPromise;
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
  }
}

// 使用 — 客户端代码不关心底层存储引擎
class UserPreferences {
  constructor(private storage: Storage) {}

  async getTheme() {
    return (await this.storage.get('theme')) ?? 'light';
  }

  async setTheme(theme: string) {
    await this.storage.set('theme', theme);
  }
}
```

```typescript
// ===== API 数据适配器 =====
// 后端返回蛇形命名，前端期望驼峰命名
interface ApiUser {
  user_id: number;
  first_name: string;
  last_name: string;
  created_at: string;
}

interface User {
  userId: number;
  firstName: string;
  lastName: string;
  createdAt: Date;
}

function adaptUser(raw: ApiUser): User {
  return {
    userId: raw.user_id,
    firstName: raw.first_name,
    lastName: raw.last_name,
    createdAt: new Date(raw.created_at),
  };
}

// 通用蛇形 → 驼峰转换器
function snakeToCamel(str: string) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function adaptObject<T>(obj: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[snakeToCamel(key)] = value;
  }
  return result as T;
}
```

---

### 3.4 外观模式（Facade）

**核心思想**：为子系统中的一组接口提供一个统一的高层接口。

**应用场景**：
- axios / fetch 封装
- 浏览器兼容层
- 复杂子系统的简化 API

```typescript
// ===== HTTP 客户端外观 =====
class HttpClient {
  private baseURL: string;
  private defaultHeaders: Record<string, string>;

  constructor(config: { baseURL: string; headers?: Record<string, string> }) {
    this.baseURL = config.baseURL;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
  }

  private async request<T>(url: string, options: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseURL}${url}`, {
      ...options,
      headers: { ...this.defaultHeaders, ...options.headers as Record<string, string> },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  get<T>(url: string) {
    return this.request<T>(url, { method: 'GET' });
  }

  post<T>(url: string, data: unknown) {
    return this.request<T>(url, { method: 'POST', body: JSON.stringify(data) });
  }

  put<T>(url: string, data: unknown) {
    return this.request<T>(url, { method: 'PUT', body: JSON.stringify(data) });
  }

  delete<T>(url: string) {
    return this.request<T>(url, { method: 'DELETE' });
  }
}

// 使用 — 简洁统一的 API
const api = new HttpClient({ baseURL: 'https://api.example.com' });
const users = await api.get<User[]>('/users');
await api.post('/users', { name: 'Alice' });
```

---

### 3.5 组合模式（Composite）

**核心思想**：将对象组合成树形结构，使客户端对单个对象和组合对象的使用具有一致性。

**应用场景**：
- 虚拟 DOM 树
- 文件目录树
- UI 组件树（菜单、布局）
- 权限树

```typescript
// ===== 虚拟 DOM 简化实现 =====
interface VNode {
  type: string;
  props: Record<string, any>;
  children: (VNode | string)[];
}

function createElement(
  type: string,
  props: Record<string, any>,
  ...children: (VNode | string)[]
): VNode {
  return { type, props: props ?? {}, children: children.flat() };
}

function render(vnode: VNode | string): HTMLElement | Text {
  if (typeof vnode === 'string') return document.createTextNode(vnode);

  const el = document.createElement(vnode.type);
  for (const [key, val] of Object.entries(vnode.props)) {
    if (key.startsWith('on')) {
      el.addEventListener(key.slice(2).toLowerCase(), val);
    } else {
      el.setAttribute(key, val);
    }
  }
  // 递归渲染子节点 — 组合模式的核心
  vnode.children.forEach(child => el.appendChild(render(child)));
  return el;
}

// 使用 — 树形结构一致操作
const tree = createElement('div', { class: 'app' },
  createElement('h1', null, 'Hello'),
  createElement('ul', null,
    createElement('li', null, 'Item 1'),
    createElement('li', null, 'Item 2'),
  ),
);
document.body.appendChild(render(tree));
```

```typescript
// ===== 菜单组件树 =====
interface MenuItem {
  label: string;
  icon?: string;
  action?: () => void;
  children?: MenuItem[];
}

function renderMenu(items: MenuItem[], depth = 0): string {
  return items.map(item => {
    const indent = '  '.repeat(depth);
    const hasChildren = item.children && item.children.length > 0;
    return [
      `${indent}<div class="menu-item level-${depth}">`,
      `${indent}  ${item.icon ?? ''} ${item.label}`,
      hasChildren ? renderMenu(item.children!, depth + 1) : '',
      `${indent}</div>`,
    ].join('\n');
  }).join('\n');
}

const menu: MenuItem[] = [
  {
    label: '文件', children: [
      { label: '新建', action: () => {} },
      { label: '打开', children: [
        { label: '最近文件' },
        { label: '从模板打开' },
      ]},
    ]
  },
  { label: '编辑', children: [
    { label: '撤销' },
    { label: '重做' },
  ]},
];
```

---

## 4. 行为型模式

### 4.1 观察者模式（Observer）

**核心思想**：定义对象间的一对多依赖关系，当一个对象状态改变时，所有依赖者都收到通知并自动更新。

**应用场景**：
- DOM 事件监听
- Vue 2 响应式系统（`Object.defineProperty`）
- `IntersectionObserver`、`MutationObserver`
- 数据绑定

```typescript
// ===== 通用 Observer =====
class EventTarget<T extends Record<string, any>> {
  private listeners = new Map<keyof T, Set<(data: any) => void>>();

  on<K extends keyof T>(event: K, listener: (data: T[K]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    // 返回取消订阅函数
    return () => this.listeners.get(event)?.delete(listener);
  }

  emit<K extends keyof T>(event: K, data: T[K]) {
    this.listeners.get(event)?.forEach(fn => fn(data));
  }
}

// 使用
interface StoreEvents {
  change: { key: string; value: unknown };
  error: Error;
}

const store = new EventTarget<StoreEvents>();
const unsub = store.on('change', ({ key, value }) => {
  console.log(`${key} changed to`, value);
});
store.emit('change', { key: 'theme', value: 'dark' });
unsub(); // 取消订阅
```

```typescript
// ===== Vue 2 响应式原理（Observer 模式）=====
function defineReactive(obj: any, key: string, val: any) {
  const watchers: Function[] = [];

  Object.defineProperty(obj, key, {
    get() {
      // 收集依赖（观察者）
      if (currentWatcher) watchers.push(currentWatcher);
      return val;
    },
    set(newVal) {
      if (newVal === val) return;
      val = newVal;
      // 通知所有观察者
      watchers.forEach(fn => fn());
    },
  });
}

let currentWatcher: Function | null = null;

function watch(fn: Function) {
  currentWatcher = fn;
  fn(); // 触发 getter，完成依赖收集
  currentWatcher = null;
}
```

---

### 4.2 发布-订阅模式（Pub/Sub）

**核心思想**：与观察者模式的区别在于引入了事件中心（Broker），发布者和订阅者完全解耦。

```
观察者模式:     Subject  →  Observer（直接通知）
发布-订阅模式:  Publisher → EventBus → Subscriber（间接通知）
```

**应用场景**：
- 全局事件总线（EventBus）
- Redux / Vuex 的 dispatch-subscribe
- WebSocket 消息分发
- 微前端通信

```typescript
// ===== 带命名空间的 EventBus =====
type Listener = (...args: any[]) => void;

class EventBus {
  private events = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener) {
    if (!this.events.has(event)) this.events.set(event, new Set());
    this.events.get(event)!.add(fn);
    return () => this.off(event, fn);
  }

  once(event: string, fn: Listener) {
    const wrapper: Listener = (...args) => {
      fn(...args);
      this.off(event, wrapper);
    };
    this.on(event, wrapper);
  }

  off(event: string, fn: Listener) {
    this.events.get(event)?.delete(fn);
  }

  emit(event: string, ...args: any[]) {
    this.events.get(event)?.forEach(fn => fn(...args));
  }

  // 支持通配符匹配
  emitWild(pattern: string, ...args: any[]) {
    const regex = new RegExp(`^${pattern.replace('*', '.*')}$`);
    for (const [event, listeners] of this.events) {
      if (regex.test(event)) {
        listeners.forEach(fn => fn(...args));
      }
    }
  }
}

// 使用
const bus = new EventBus();
bus.on('user:login', (user) => console.log('Logged in:', user));
bus.on('user:logout', () => console.log('Logged out'));
bus.emit('user:login', { name: 'Alice' });
bus.emitWild('user:*', 'broadcast to all user events');
```

```typescript
// ===== React 中用自定义 Hook 封装 =====
const globalBus = new EventBus();

function useEventBus(event: string, handler: Listener) {
  useEffect(() => {
    const unsub = globalBus.on(event, handler);
    return unsub;
  }, [event, handler]);

  return {
    emit: (...args: any[]) => globalBus.emit(event, ...args),
  };
}
```

---

### 4.3 策略模式（Strategy）

**核心思想**：定义一系列算法，将每个算法封装为独立策略，使它们可以互相替换。

**应用场景**：
- 表单校验规则
- 排序算法选择
- 支付方式切换
- 动画缓动函数
- 权限校验策略

```typescript
// ===== 表单校验 =====
type Validator = (value: string) => string | null; // 返回错误信息或 null

// 策略集合
const validators: Record<string, Validator> = {
  required: (v) => (v.trim() ? null : '此字段为必填项'),
  email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : '邮箱格式不正确'),
  minLength: (min: number) => (v: string) =>
    v.length >= min ? null : `最少需要 ${min} 个字符`,
  phone: (v) => (/^1[3-9]\d{9}$/.test(v) ? null : '手机号格式不正确'),
  url: (v) => {
    try { new URL(v); return null; } catch { return 'URL 格式不正确'; }
  },
};

// 校验引擎
function validate(value: string, rules: Validator[]): string[] {
  return rules
    .map(rule => rule(value))
    .filter((err): err is string => err !== null);
}

// 使用
const emailErrors = validate('invalid', [
  validators.required,
  validators.email,
]);
// → ['邮箱格式不正确']
```

```typescript
// ===== 支付策略 =====
interface PaymentStrategy {
  pay(amount: number): Promise<{ success: boolean; transactionId: string }>;
}

class AlipayStrategy implements PaymentStrategy {
  async pay(amount: number) {
    console.log(`Alipay: ¥${amount}`);
    // 调用支付宝 SDK...
    return { success: true, transactionId: `ALIPAY_${Date.now()}` };
  }
}

class WechatPayStrategy implements PaymentStrategy {
  async pay(amount: number) {
    console.log(`WeChatPay: ¥${amount}`);
    return { success: true, transactionId: `WECHAT_${Date.now()}` };
  }
}

class CreditCardStrategy implements PaymentStrategy {
  constructor(private cardNumber: string) {}
  async pay(amount: number) {
    console.log(`CreditCard ${this.cardNumber}: ¥${amount}`);
    return { success: true, transactionId: `CARD_${Date.now()}` };
  }
}

// 上下文
class PaymentContext {
  private strategy: PaymentStrategy;

  setStrategy(strategy: PaymentStrategy) {
    this.strategy = strategy;
  }

  async checkout(amount: number) {
    if (!this.strategy) throw new Error('No payment strategy set');
    return this.strategy.pay(amount);
  }
}

// 使用
const payment = new PaymentContext();
payment.setStrategy(new AlipayStrategy());
await payment.checkout(99.9);
```

---

### 4.4 命令模式（Command）

**核心思想**：将请求封装为对象，支持撤销、重做、命令队列和宏命令。

**应用场景**：
- 编辑器撤销/重做（Undo/Redo）
- 快捷键绑定系统
- 批量操作 / 事务
- 宏录制

```typescript
// ===== 编辑器撤销/重做系统 =====
interface Command {
  execute(): void;
  undo(): void;
}

class CommandHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  execute(command: Command) {
    command.execute();
    this.undoStack.push(command);
    this.redoStack.length = 0; // 新命令清空 redo 栈
  }

  undo() {
    const command = this.undoStack.pop();
    if (command) {
      command.undo();
      this.redoStack.push(command);
    }
  }

  redo() {
    const command = this.redoStack.pop();
    if (command) {
      command.execute();
      this.undoStack.push(command);
    }
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}

// 具体命令：文本插入
class InsertTextCommand implements Command {
  constructor(
    private editor: { content: string },
    private position: number,
    private text: string,
  ) {}

  execute() {
    const { content } = this.editor;
    this.editor.content =
      content.slice(0, this.position) + this.text + content.slice(this.position);
  }

  undo() {
    const { content } = this.editor;
    this.editor.content =
      content.slice(0, this.position) + content.slice(this.position + this.text.length);
  }
}

// 具体命令：删除文本
class DeleteTextCommand implements Command {
  private deletedText = '';

  constructor(
    private editor: { content: string },
    private position: number,
    private length: number,
  ) {}

  execute() {
    this.deletedText = this.editor.content.slice(
      this.position,
      this.position + this.length,
    );
    this.editor.content =
      this.editor.content.slice(0, this.position) +
      this.editor.content.slice(this.position + this.length);
  }

  undo() {
    this.editor.content =
      this.editor.content.slice(0, this.position) +
      this.deletedText +
      this.editor.content.slice(this.position);
  }
}

// 宏命令：组合多个命令
class MacroCommand implements Command {
  private commands: Command[] = [];

  add(command: Command) {
    this.commands.push(command);
    return this;
  }

  execute() {
    this.commands.forEach(cmd => cmd.execute());
  }

  undo() {
    // 逆序撤销
    [...this.commands].reverse().forEach(cmd => cmd.undo());
  }
}

// 使用
const editor = { content: 'Hello World' };
const history = new CommandHistory();

history.execute(new InsertTextCommand(editor, 5, ' Beautiful'));
console.log(editor.content); // "Hello Beautiful World"

history.undo();
console.log(editor.content); // "Hello World"

history.redo();
console.log(editor.content); // "Hello Beautiful World"
```

---

### 4.5 迭代器模式（Iterator）

**核心思想**：提供一种方法顺序访问聚合对象中的元素，而不暴露其底层表示。

**应用场景**：
- `for...of` 循环
- 自定义集合遍历
- 无限滚动分页
- 树形结构深度/广度遍历

```typescript
// ===== 分页迭代器 =====
async function* paginatedFetch<T>(
  url: string,
  pageSize = 20,
): AsyncGenerator<T[], void, unknown> {
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(`${url}?page=${page}&size=${pageSize}`);
    const data: T[] = await response.json();

    if (data.length < pageSize) hasMore = false;
    page++;

    yield data;
  }
}

// 使用
for await (const batch of paginatedFetch<User>('/api/users')) {
  batch.forEach(user => renderUserCard(user));
}
```

```typescript
// ===== 树形结构迭代器 =====
interface TreeNode<T> {
  value: T;
  children: TreeNode<T>[];
}

// 深度优先遍历
function* dfs<T>(node: TreeNode<T>): Generator<T> {
  yield node.value;
  for (const child of node.children) {
    yield* dfs(child);
  }
}

// 广度优先遍历
function* bfs<T>(root: TreeNode<T>): Generator<T> {
  const queue: TreeNode<T>[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    yield node.value;
    queue.push(...node.children);
  }
}

// 使用
const fileTree: TreeNode<string> = {
  value: 'src',
  children: [
    { value: 'components', children: [
      { value: 'Button.tsx', children: [] },
      { value: 'Input.tsx', children: [] },
    ]},
    { value: 'utils', children: [
      { value: 'helpers.ts', children: [] },
    ]},
  ],
};

for (const name of dfs(fileTree)) {
  console.log(name); // src, components, Button.tsx, Input.tsx, utils, helpers.ts
}
```

---

### 4.6 状态模式（State）

**核心思想**：允许对象在内部状态改变时改变行为，将状态相关的逻辑封装到独立的状态类中。

**应用场景**：
- 有限状态机（FSM）
- 订单状态流转
- 播放器状态（播放/暂停/停止）
- 表单步骤向导

```typescript
// ===== 有限状态机：订单流程 =====
type OrderStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled';

interface StateAction {
  pay?(): OrderStatus;
  ship?(): OrderStatus;
  deliver?(): OrderStatus;
  cancel?(): OrderStatus;
}

const stateTransitions: Record<OrderStatus, StateAction> = {
  pending: {
    pay: () => 'paid',
    cancel: () => 'cancelled',
  },
  paid: {
    ship: () => 'shipped',
    cancel: () => 'cancelled',
  },
  shipped: {
    deliver: () => 'delivered',
  },
  delivered: {},
  cancelled: {},
};

class Order {
  status: OrderStatus = 'pending';

  private transition(action: keyof StateAction) {
    const handler = stateTransitions[this.status][action];
    if (!handler) {
      throw new Error(`Cannot ${action} when order is ${this.status}`);
    }
    this.status = handler();
    console.log(`Order → ${this.status}`);
  }

  pay() { this.transition('pay'); }
  ship() { this.transition('ship'); }
  deliver() { this.transition('deliver'); }
  cancel() { this.transition('cancel'); }
}

// 使用
const order = new Order();
order.pay();     // Order → paid
order.ship();    // Order → shipped
order.deliver(); // Order → delivered
order.cancel();  // Error: Cannot cancel when order is delivered
```

```typescript
// ===== 轻量状态机（React Hook）=====
type Machine<S extends string, E extends string> = {
  initial: S;
  states: Record<S, { on?: Partial<Record<E, S>> }>;
};

function useMachine<S extends string, E extends string>(machine: Machine<S, E>) {
  const [state, setState] = useState(machine.initial);

  const send = useCallback((event: E) => {
    setState(current => {
      const next = machine.states[current]?.on?.[event];
      return next ?? current;
    });
  }, [machine]);

  return [state, send] as const;
}

// 使用
const toggleMachine = {
  initial: 'inactive' as const,
  states: {
    inactive: { on: { TOGGLE: 'active' as const } },
    active: { on: { TOGGLE: 'inactive' as const } },
  },
};

function Toggle() {
  const [state, send] = useMachine(toggleMachine);
  return (
    <button onClick={() => send('TOGGLE')}>
      {state === 'active' ? 'ON' : 'OFF'}
    </button>
  );
}
```

---

### 4.7 中介者模式（Mediator）

**核心思想**：用一个中介对象来封装一系列对象之间的交互，使各对象不需要显式引用彼此。

**应用场景**：
- Redux/Vuex Store（组件通过 Store 通信）
- 聊天室
- 表单联动

```typescript
// ===== 表单字段联动中介者 =====
class FormMediator {
  private fields = new Map<string, FormField>();

  register(field: FormField) {
    this.fields.set(field.name, field);
    field.setMediator(this);
  }

  notify(sender: string, event: string, data: any) {
    // 集中处理联动逻辑
    if (sender === 'country' && event === 'change') {
      const cityField = this.fields.get('city');
      cityField?.updateOptions(getCitiesByCountry(data));
    }

    if (sender === 'quantity' && event === 'change') {
      const totalField = this.fields.get('total');
      const priceField = this.fields.get('price');
      const price = priceField?.getValue() ?? 0;
      totalField?.setValue(price * data);
    }
  }
}

class FormField {
  private mediator!: FormMediator;
  private value: any;
  private options: any[] = [];

  constructor(public name: string) {}

  setMediator(mediator: FormMediator) {
    this.mediator = mediator;
  }

  setValue(val: any) {
    this.value = val;
    this.mediator.notify(this.name, 'change', val);
  }

  getValue() { return this.value; }
  updateOptions(opts: any[]) { this.options = opts; }
}

// 使用
const mediator = new FormMediator();
const country = new FormField('country');
const city = new FormField('city');
mediator.register(country);
mediator.register(city);

country.setValue('China'); // 自动触发城市下拉更新
```

---

### 4.8 责任链模式（Chain of Responsibility）

**核心思想**：将请求沿着处理链传递，每个处理者决定处理请求或传递给下一个。

**应用场景**：
- Express/Koa 中间件
- axios 拦截器
- 权限校验链
- 日志处理链

```typescript
// ===== Koa 风格中间件引擎 =====
type Middleware<T> = (ctx: T, next: () => Promise<void>) => Promise<void>;

class Pipeline<T> {
  private middlewares: Middleware<T>[] = [];

  use(middleware: Middleware<T>) {
    this.middlewares.push(middleware);
    return this;
  }

  async execute(ctx: T) {
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;
      const fn = this.middlewares[i];
      if (!fn) return;
      await fn(ctx, () => dispatch(i + 1));
    };

    await dispatch(0);
  }
}

// 使用
interface Context {
  req: { url: string; headers: Record<string, string> };
  res: { status: number; body: any };
  state: Record<string, any>;
}

const app = new Pipeline<Context>();

// 中间件 1：日志
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  console.log(`${ctx.req.url} - ${ctx.res.status} - ${Date.now() - start}ms`);
});

// 中间件 2：鉴权
app.use(async (ctx, next) => {
  const token = ctx.req.headers['authorization'];
  if (!token) {
    ctx.res.status = 401;
    ctx.res.body = { error: 'Unauthorized' };
    return; // 不调用 next()，中断链
  }
  ctx.state.user = verifyToken(token);
  await next();
});

// 中间件 3：业务处理
app.use(async (ctx, next) => {
  ctx.res.status = 200;
  ctx.res.body = { message: 'Hello', user: ctx.state.user };
});
```

```typescript
// ===== axios 风格拦截器链 =====
class InterceptorChain<T> {
  private handlers: Array<{
    fulfilled: (value: T) => T | Promise<T>;
    rejected?: (error: any) => any;
  }> = [];

  use(
    fulfilled: (value: T) => T | Promise<T>,
    rejected?: (error: any) => any,
  ) {
    this.handlers.push({ fulfilled, rejected });
    return this.handlers.length - 1;
  }

  async run(initial: T): Promise<T> {
    let result: T = initial;
    for (const { fulfilled, rejected } of this.handlers) {
      try {
        result = await fulfilled(result);
      } catch (err) {
        if (rejected) result = await rejected(err);
        else throw err;
      }
    }
    return result;
  }
}

// 使用 — 请求拦截器
const requestChain = new InterceptorChain<RequestInit>();
requestChain.use((config) => {
  config.headers = { ...config.headers, 'X-Request-Id': crypto.randomUUID() };
  return config;
});
requestChain.use((config) => {
  console.log('Request:', config);
  return config;
});
```

---

## 5. 前端专属模式

### 5.1 模块模式（Module）

**核心思想**：利用闭包实现信息隐藏和封装，暴露公有 API。

```typescript
// ===== 模块模式（IIFE 时代）=====
const CounterModule = (() => {
  // 私有变量
  let count = 0;
  const MAX = 100;

  // 私有方法
  function validate(n: number) {
    return n >= 0 && n <= MAX;
  }

  // 公有 API
  return {
    increment() {
      if (validate(count + 1)) count++;
      return count;
    },
    decrement() {
      if (validate(count - 1)) count--;
      return count;
    },
    getCount: () => count,
    reset: () => { count = 0; },
  };
})();

CounterModule.increment(); // 1
CounterModule.getCount();  // 1
// count 和 validate 外部不可访问
```

```typescript
// ===== 现代 ES Module 写法 =====
// counter.ts
let count = 0; // 模块级私有

export const increment = () => ++count;
export const decrement = () => --count;
export const getCount = () => count;

// 导入方只能访问 export 的部分
```

---

### 5.2 Mixin 模式

**核心思想**：将可复用的功能混入目标对象/类中，实现多重继承的效果。

```typescript
// ===== TypeScript Mixin =====
type Constructor = new (...args: any[]) => {};

// Mixin: 可序列化
function Serializable<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    toJSON() {
      return JSON.stringify(this);
    }
    static fromJSON(json: string) {
      return Object.assign(new this(), JSON.parse(json));
    }
  };
}

// Mixin: 可验证
function Validatable<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    validate() {
      for (const [key, value] of Object.entries(this)) {
        if (value === null || value === undefined) {
          throw new Error(`${key} is required`);
        }
      }
      return true;
    }
  };
}

// Mixin: 事件能力
function EventEmitting<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    private _listeners = new Map<string, Set<Function>>();

    on(event: string, fn: Function) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event)!.add(fn);
    }

    emit(event: string, ...args: any[]) {
      this._listeners.get(event)?.forEach(fn => fn(...args));
    }
  };
}

// 组合使用
class User {
  constructor(public name: string, public email: string) {}
}

const EnhancedUser = EventEmitting(Validatable(Serializable(User)));
const user = new EnhancedUser('Alice', 'alice@example.com');
user.validate();  // true
user.toJSON();    // 序列化
user.on('save', () => console.log('saved'));
```

```typescript
// ===== Vue 2 Mixins =====
// 已被 Vue 3 Composables 取代，但面试常问
const timestampMixin = {
  data() {
    return { createdAt: new Date() };
  },
  methods: {
    formatDate(date: Date) {
      return date.toLocaleDateString();
    },
  },
  created() {
    console.log('Component created at:', this.createdAt);
  },
};

// Vue 2 组件使用
export default {
  mixins: [timestampMixin],
  // createdAt 和 formatDate 会被混入
};
```

---

### 5.3 HOC / Render Props / Hooks 模式

**React 逻辑复用三代演进**：

```
HOC（装饰器模式） → Render Props（控制反转） → Hooks（组合模式）
```

```tsx
// ===== 1. HOC 模式 =====
function withWindowSize<P extends { windowSize: { width: number; height: number } }>(
  Component: React.ComponentType<P>,
) {
  return function (props: Omit<P, 'windowSize'>) {
    const [size, setSize] = useState({
      width: window.innerWidth,
      height: window.innerHeight,
    });

    useEffect(() => {
      const handler = () => setSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
      window.addEventListener('resize', handler);
      return () => window.removeEventListener('resize', handler);
    }, []);

    return <Component {...(props as P)} windowSize={size} />;
  };
}

// 使用
const ResponsiveComponent = withWindowSize(MyComponent);
```

```tsx
// ===== 2. Render Props 模式 =====
function MouseTracker({ children }: {
  children: (pos: { x: number; y: number }) => React.ReactNode;
}) {
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  return <>{children(pos)}</>;
}

// 使用
<MouseTracker>
  {({ x, y }) => <div>鼠标位置: {x}, {y}</div>}
</MouseTracker>
```

```tsx
// ===== 3. Hooks 模式（推荐）=====
function useWindowSize() {
  const [size, setSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    const handler = () => setSize({
      width: window.innerWidth,
      height: window.innerHeight,
    });
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return size;
}

function useMousePosition() {
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  return pos;
}

// 使用 — 可自由组合，无嵌套地狱
function Dashboard() {
  const { width } = useWindowSize();
  const { x, y } = useMousePosition();

  return (
    <div>
      <p>窗口宽度: {width}</p>
      <p>鼠标: {x}, {y}</p>
    </div>
  );
}
```

---

## 6. 模式选型速查表

```
需求场景                              推荐模式              避免
──────────────────────────────────────────────────────────────────────
全局只需一个实例                       单例 / ES Module      滥用全局变量
根据条件创建不同对象                   工厂                  大量 if-else
复杂对象链式构建                       建造者                超长构造函数参数
控制对象访问/增强功能                  代理                  直接修改原对象
动态扩展对象行为                       装饰器                深度继承
统一不兼容接口                         适配器                修改第三方源码
简化复杂子系统                         外观                  暴露过多内部细节
树形结构递归操作                       组合                  类型判断 + 强转
一对多实时通知                         观察者                轮询
完全解耦的模块通信                     发布-订阅             直接引用
多种可互换算法                         策略                  switch-case 堆叠
撤销/重做/命令队列                     命令                  直接调用 + 手动回滚
复杂状态流转                           状态机                嵌套 if-else
多对象交互协调                         中介者                两两直接引用
请求流水线处理                         责任链/中间件          嵌套回调
React 逻辑复用                        Hooks                 HOC 嵌套 > 3 层
```

---

## 7. 面试高频问题

### Q1: 观察者模式和发布-订阅模式的区别？

```
                观察者模式                    发布-订阅模式
─────────────────────────────────────────────────────────────
耦合度          Subject 知道 Observer          Publisher/Subscriber 互不知晓
中间层          无                             有事件中心 (EventBus/Broker)
通信方式        直接调用                       通过事件名间接通信
典型实现        DOM addEventListener           Redux、EventEmitter
灵活度          相对较低                       更灵活，支持跨模块
调试难度        较低                           较高（事件流不直观）
```

### Q2: 工厂模式和策略模式的区别？

- **工厂模式**：关注**创建什么对象**，将创建逻辑与使用逻辑分离
- **策略模式**：关注**如何执行行为**，将算法封装为可互换的策略

```typescript
// 工厂 — 创建不同的图表对象
const chart = ChartFactory.create('bar');

// 策略 — 对同一份数据使用不同的排序方式
const sorted = sort(data, strategies.quickSort);
```

### Q3: 装饰器模式和代理模式的区别？

- **装饰器**：增强原有功能，可以叠加多个装饰器（洋葱模型）
- **代理**：控制对原对象的访问，通常只有一层代理

```typescript
// 装饰器 — 可叠加
const fn = withLog(withAuth(withCache(originalFn)));

// 代理 — 控制访问
const proxy = new Proxy(target, handler);
```

### Q4: 如何实现一个简单的依赖注入容器？

```typescript
class Container {
  private bindings = new Map<string, () => any>();

  bind<T>(key: string, factory: () => T) {
    this.bindings.set(key, factory);
  }

  singleton<T>(key: string, factory: () => T) {
    let instance: T;
    this.bindings.set(key, () => (instance ??= factory()));
  }

  resolve<T>(key: string): T {
    const factory = this.bindings.get(key);
    if (!factory) throw new Error(`No binding for ${key}`);
    return factory();
  }
}

// 使用
const container = new Container();
container.singleton('logger', () => new Logger());
container.bind('userService', () => new UserService(container.resolve('logger')));

const service = container.resolve<UserService>('userService');
```

### Q5: 前端开发中最常用的三个设计模式？

1. **观察者/发布-订阅**：事件系统、响应式数据、状态管理无处不在
2. **策略模式**：表单校验、路由守卫、支付逻辑等场景高频使用
3. **代理模式**：Vue 3 响应式、ES6 Proxy、缓存代理是现代前端基石

### Q6: 设计模式在 React/Vue 中的体现？

| 框架机制 | 对应模式 |
|---------|---------|
| Vue 3 `reactive()` | 代理模式 |
| Vue 2 `Object.defineProperty` | 观察者模式 |
| React HOC | 装饰器模式 |
| React Hooks | 模块模式 + 组合模式 |
| Redux `dispatch → reducer` | 命令模式 + 中介者模式 |
| React `Context.Provider` | 发布-订阅模式 |
| Vue `provide/inject` | 依赖注入 |
| Virtual DOM | 组合模式 |
| Express/Koa 中间件 | 责任链模式 |
| Webpack Plugin | 发布-订阅 + 策略模式 |
