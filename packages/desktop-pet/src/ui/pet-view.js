import { initialPresentation, presentationReducer, selectAction } from '../core/presentation-machine.js';
export function createPetView(element, { pack }) {
  const img = element.ownerDocument.createElement('img');
  img.className = 'pet-image';
  img.draggable = false;
  element.replaceChildren(img);
  let state = initialPresentation();
  let currentPack = pack;
  let destroyed = false;
  function render() {
    if (destroyed || !currentPack) return;
    const action = selectAction(currentPack.manifest, state);
    const asset = currentPack.manifest.actions[action].asset;
    img.src = currentPack.assets[asset];
    img.alt = currentPack.name;
    element.dataset.activity = state.activity;
    element.dataset.connection = state.connectionStatus;
  }
  render();
  return {
    setPack(value) { if (destroyed) return; img.removeAttribute('src'); currentPack = value; render(); },
    setActivity(value) { state = presentationReducer(state, {type:'activity', value}); render(); },
    setConnection(value) { state = presentationReducer(state, {type:'connection', value}); render(); },
    destroy() { destroyed = true; currentPack = null; img.removeAttribute('src'); img.remove(); }
  };
}
