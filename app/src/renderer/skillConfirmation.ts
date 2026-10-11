import { userError } from '../shared/errors.mjs';
const api = window.multiplane;

// A modal dialog keeps keyboard focus inside the confirmation until it closes.
api.onSkillConfirmation(confirmation => {
  const previous = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.className = 'skill-confirmation';
  dialog.setAttribute('aria-labelledby', 'skill-confirmation-title');
  dialog.setAttribute('aria-describedby', 'skill-confirmation-detail');
  const title = document.createElement('h2'); title.id = 'skill-confirmation-title'; title.textContent = confirmation.title;
  const detail = document.createElement('p'); detail.id = 'skill-confirmation-detail'; detail.textContent = confirmation.detail;
  const actions = document.createElement('div'); actions.className = 'actions';
  const cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.autofocus = true;
  const accept = document.createElement('button'); accept.textContent = confirmation.action; accept.className = confirmation.danger ? 'danger' : 'primary';
  let answered = false;
  const answer = (accepted: boolean) => {
    if (answered) return; answered = true;
    dialog.close(); dialog.remove();
    if (previous?.isConnected) previous.focus();
    void api.answerSkillConfirmation(confirmation.id, accepted).catch(error => {
      const banner = document.querySelector<HTMLElement>('#error');
      if (banner) { banner.textContent = userError(error); banner.hidden = false; }
    });
  };
  cancel.onclick = () => answer(false); accept.onclick = () => answer(true);
  dialog.addEventListener('cancel', event => { event.preventDefault(); answer(false); });
  actions.append(cancel, accept); dialog.append(title, detail, actions); document.body.append(dialog);
  dialog.showModal(); cancel.focus();
});
