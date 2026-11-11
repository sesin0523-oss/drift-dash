// 실시간 채팅 창.
// 로비/결과 화면에서는 패널 안에 붙어 있고, 레이스 중에는 왼쪽 아래에 떠 있다.
// 레이스 중에는 Enter 로 열고, 보내거나 Esc 를 누르면 닫혀서 바로 운전으로 돌아간다.
// 메시지는 항상 textContent 로 넣는다 (다른 사람이 보낸 HTML 이 실행되지 않게).

const FADE_MS = 12000;   // 레이스 중 메시지가 화면에 남는 시간

export class Chat {
  constructor({ send, colorOf, onOpenChange, onIncoming }) {
    this.root = document.getElementById('chat');
    this.log = document.getElementById('chatLog');
    this.form = document.getElementById('chatForm');
    this.input = document.getElementById('chatInput');
    this.toggleBtn = document.getElementById('chatToggle');
    this.send = send;
    this.colorOf = colorOf;
    this.onOpenChange = onOpenChange;
    this.onIncoming = onIncoming;
    this.floating = false;
    this.isOpen = false;
    this.unread = 0;

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (text) this.send(text);
      this.input.value = '';
      if (this.floating) this.close();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.input.value = ''; if (this.floating) this.close(); else this.input.blur(); }
      e.stopPropagation();   // 채팅 입력 중에는 게임 키로 처리되지 않게
    });
    this.toggleBtn.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));

    // 오래된 메시지는 레이스 중에 서서히 사라짐
    setInterval(() => this.fadeOld(), 500);
  }

  /** panel 안에 붙이기 (로비/결과) 또는 null 이면 화면에 띄우기 (레이스) */
  placeIn(panel) {
    this.floating = !panel;
    if (panel) {
      panel.append(this.root);
      this.root.className = 'embedded';
      this.isOpen = true;
    } else {
      document.body.append(this.root);
      this.root.className = 'floating';
      this.isOpen = false;
    }
    this.unread = 0;
    this.updateToggle();
    this.scrollDown();
  }

  open() {
    if (!this.floating) { this.input.focus(); return; }
    this.isOpen = true;
    this.root.classList.add('open');
    this.unread = 0;
    this.updateToggle();
    this.scrollDown();
    this.input.focus();
    this.onOpenChange?.(true);
  }

  close() {
    if (!this.floating) return;
    this.isOpen = false;
    this.root.classList.remove('open');
    this.input.blur();
    this.updateToggle();
    this.onOpenChange?.(false);
  }

  add(m) {
    const line = document.createElement('div');
    line.className = 'line' + (m.sys ? ' sys' : '');
    line.dataset.time = Date.now();
    if (m.sys) {
      line.textContent = m.text;
    } else {
      const who = document.createElement('b');
      who.textContent = m.name;
      who.style.color = this.colorOf(m.color);
      const text = document.createElement('span');
      text.textContent = ' ' + m.text;
      line.append(who, text);
    }
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 30;
    this.log.append(line);
    while (this.log.children.length > 80) this.log.firstChild.remove();
    if (atBottom || !this.isOpen) this.scrollDown();
    if (this.floating && !this.isOpen && !m.sys) { this.unread++; this.updateToggle(); }
    if (!m.sys) this.onIncoming?.(m);
  }

  fadeOld() {
    const now = Date.now();
    for (const line of this.log.children)
      line.classList.toggle('old', now - Number(line.dataset.time) > FADE_MS);
  }

  scrollDown() { this.log.scrollTop = this.log.scrollHeight; }

  updateToggle() {
    this.toggleBtn.textContent = this.isOpen ? '닫기' : this.unread ? `채팅 ${this.unread}` : '채팅';
    this.toggleBtn.classList.toggle('has-unread', this.unread > 0 && !this.isOpen);
  }
}
