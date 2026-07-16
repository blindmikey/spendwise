/**
 * x-component system: each <template x-component="name"> in index.html becomes
 * a <x-name> custom element - one source of truth per component. Attributes on
 * the element flow into the template's Alpine scope via xProps (helpers.js);
 * <slot> (default and named) is replaced with the element's original children.
 *
 * Must run before Alpine boots (Alpine is loaded with defer; this is not).
 */
'use strict';

function parseCustomComponents () {
    document.querySelectorAll('template[x-component]').forEach((template) => {
        const name = `x-${template.getAttribute('x-component')}`;

        class Component extends HTMLElement {
            connectedCallback () {
                const content = template.content.cloneNode(true);

                content.querySelectorAll('slot').forEach((slot) => {
                    const slotName = slot.getAttribute('name');
                    if (slotName) {
                        const match = this.querySelector(`[slot="${slotName}"]`);
                        if (match) slot.replaceWith(match.cloneNode(true));
                        else slot.remove();
                    } else {
                        const children = Array.from(this.childNodes).filter((n) =>
                            n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE);
                        slot.replaceWith(...children.map((n) => n.cloneNode(true)));
                    }
                });

                this.innerHTML = '';
                this.appendChild(content);
            }
        }

        customElements.define(name, Component);
    });
}
