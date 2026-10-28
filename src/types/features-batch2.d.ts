/*
 * Declarations used by the tabs / files / sessions / compare / macros / ai-* features that no shared d.ts holds.
 * Declaration merging only: nothing here is a module.
 */

declare namespace monaco.editor {
  interface ICodeEditor {
    /** Fires with the text typed by the user (a public member of the editor widget that monaco.d.ts leaves out). */
    readonly onDidType: IEvent<string>;
  }
}
