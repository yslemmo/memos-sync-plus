import moment from 'moment';
import { vi } from 'vitest';
import { parse, stringify } from 'yaml';
export const parseYaml = parse;
export const stringifyYaml = stringify;
export { moment };
export const requestUrl = vi.fn();
export class App {}
export class Notice { constructor(public message: string) {} }
export class TFile { constructor(public path: string) {} get basename() { return this.path.split('/').pop()!.replace(/\.md$/, ''); } }
export class TFolder { constructor(public path: string) {} }
export class Plugin {
  manifest = { id: 'memos-sync' };
  commands: Record<string, any> = {};
  tabs: PluginSettingTab[] = [];
  data: unknown = null;
  constructor(public app: any) {}
  async loadData() { return this.data; }
  async saveData(data: unknown) { this.data = JSON.parse(JSON.stringify(data)); }
  addStatusBarItem() { return document.createElement('div'); }
  registerDomEvent(el: HTMLElement, event: string, cb: EventListener) { el.addEventListener(event, cb); }
  addRibbonIcon() {}
  addCommand(command: any) { this.commands[command.id] = command; }
  addSettingTab(tab: PluginSettingTab) { this.tabs.push(tab); }
  registerInterval() {}
  registerEvent() {}
}
export class Modal {
  contentEl = document.createElement('div');
  constructor(public app: any) {}
  open() { (this as any).onOpen?.(); }
  close() { (this as any).onClose?.(); }
}
export class PluginSettingTab {
  containerEl = document.createElement('div');
  constructor(public app: any, public plugin: any) {}
}
class Control {
  inputEl = document.createElement('input');
  constructor(parent: HTMLElement) { parent.append(this.inputEl); }
  setValue(value: any) { if (typeof value === 'boolean') this.inputEl.checked = value; else this.inputEl.value = value; return this; }
  getValue() { return this.inputEl.value; }
  setPlaceholder(value: string) { this.inputEl.placeholder = value; return this; }
  onChange(fn: (value: any) => unknown) { this.inputEl.addEventListener('change', () => fn(this.inputEl.type === 'checkbox' ? this.inputEl.checked : this.inputEl.value)); return this; }
}
class Button {
  constructor(public buttonEl: HTMLButtonElement) {}
  setButtonText(value: string) { this.buttonEl.textContent = value; return this; }
  setCta() { return this; }
  onClick(fn: () => unknown) { this.buttonEl.addEventListener('click', fn); return this; }
}
class Dropdown {
  selectEl = document.createElement('select');
  constructor(parent: HTMLElement) { parent.append(this.selectEl); }
  addOptions(options: Record<string, string>) { Object.entries(options).forEach(([value, text]) => { const o = document.createElement('option'); o.value = value; o.textContent = text; this.selectEl.append(o); }); return this; }
  setValue(value: string) { this.selectEl.value = value; return this; }
  onChange(fn: (value: string) => unknown) { this.selectEl.addEventListener('change', () => fn(this.selectEl.value)); return this; }
}
export class Setting {
  element = document.createElement('div');
  constructor(parent: HTMLElement) { parent.append(this.element); }
  setName(name: string) { this.element.dataset.name = name; return this; }
  setDesc(desc: string) { this.element.dataset.description = desc; return this; }
  addText(fn: (control: Control) => unknown) { fn(new Control(this.element)); return this; }
  addTextArea(fn: (control: Control) => unknown) { const c = new Control(this.element); c.inputEl.remove(); c.inputEl = document.createElement('textarea') as any; this.element.append(c.inputEl); fn(c); return this; }
  addToggle(fn: (control: Control) => unknown) { const c = new Control(this.element); c.inputEl.type = 'checkbox'; fn(c); return this; }
  addButton(fn: (control: Button) => unknown) { const b = document.createElement('button'); this.element.append(b); fn(new Button(b)); return this; }
  addDropdown(fn: (control: Dropdown) => unknown) { fn(new Dropdown(this.element)); return this; }
}
