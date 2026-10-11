export const floatingThumb = () => '<span class="sc-thumb" aria-hidden="true"></span>';
export function installScrollMaterial(root: HTMLElement, layerHost: HTMLElement = document.body) {
    const layer = document.createElement('div');
    layer.className = 'thumb-layer';
    layerHost.append(layer);
    const bound = new Map<HTMLElement, {
        update(): void;
        dispose(): void;
    }>();
    let queued = false, disposed = false;
    const scan = () => {
        queued = false;
        if (disposed)
            return;
        const containers = new Set(Array.from(root.querySelectorAll<HTMLElement>('.scroll')));
        for (const [element, binding] of bound)
            if (!containers.has(element)) {
                binding.dispose();
                bound.delete(element);
            }
        for (const element of containers) {
            if (!bound.has(element))
                bound.set(element, attach(element));
            bound.get(element)!.update();
        }
    };
    const schedule = () => { if (!queued) {
        queued = true;
        requestAnimationFrame(scan);
    } };
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    function attach(container: HTMLElement) {
        container.classList.add('has-thumb');
        const template = document.createElement('template');
        template.innerHTML = floatingThumb();
        const thumb = template.content.firstElementChild as HTMLElement;
        layer.append(thumb);
        let hovered = false, frame = 0;
        let timer: ReturnType<typeof setTimeout>;
        let drag: {
            id: number;
            y: number;
            scroll: number;
            ratio: number;
        } | undefined;
        const headerHeight = () => {
            const compact = container.parentElement?.querySelector<HTMLElement>(':scope > [data-plan-top]');
            if (compact) {
                const plan = container.querySelector<HTMLElement>('.plan');
                compact.hidden = !plan || plan.getBoundingClientRect().bottom > container.getBoundingClientRect().top;
                return compact.hidden ? 0 : compact.offsetHeight;
            }
            return container.querySelector<HTMLElement>(':scope > .page-h.sticky')?.offsetHeight ?? 0;
        };
        const place = () => {
            frame = 0;
            const header = container.querySelector<HTMLElement>(':scope > .page-h.sticky');
            const footer = container.querySelector<HTMLElement>(':scope > .settings-footer, :scope > .card-f');
            header?.classList.toggle('stuck', container.scrollTop > 0);
            container.parentElement?.classList.toggle('edge-on', container.scrollTop > 0);
            const top = headerHeight() + 4, bottom = (footer?.offsetHeight ?? 0) + 4;
            const track = container.clientHeight - top - bottom, range = container.scrollHeight - container.clientHeight;
            thumb.hidden = range <= 1 || track <= 0 || !container.getClientRects().length;
            if (thumb.hidden)
                return;
            const size = Math.min(track, Math.max(28, track * container.clientHeight / container.scrollHeight));
            thumb.style.height = `${size}px`;
            const rect = container.getBoundingClientRect();
            const y = rect.top + container.clientTop + top + (track - size) * Math.max(0, Math.min(1, container.scrollTop / range));
            let visibleTop = 0, visibleBottom = innerHeight;
            for (let parent = container.parentElement; parent; parent = parent.parentElement) {
                if (/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) {
                    const r = parent.getBoundingClientRect();
                    visibleTop = Math.max(visibleTop, r.top);
                    visibleBottom = Math.min(visibleBottom, r.bottom);
                    const head = parent.querySelector<HTMLElement>(':scope > .settings-header, :scope > .page-h');
                    if (head)
                        visibleTop = Math.max(visibleTop, head.getBoundingClientRect().bottom);
                }
            }
            thumb.hidden = y < visibleTop - 1 || y + size > visibleBottom + 1;
            thumb.style.transform = `translate(${Math.round(rect.right - 7)}px, ${y}px)`;
        };
        const update = () => { if (!frame)
            frame = requestAnimationFrame(place); };
        const show = () => { clearTimeout(timer); thumb.classList.add('show', 'is-on'); };
        const later = () => { clearTimeout(timer); timer = setTimeout(() => { if (!hovered && !drag)
            thumb.classList.remove('show', 'is-on'); }, 800); };
        const enter = () => { hovered = true; show(); };
        const leave = () => { hovered = false; later(); };
        for (const el of [container, thumb]) {
            el.addEventListener('mouseenter', enter);
            el.addEventListener('mouseleave', leave);
        }
        const scroll = () => { update(); show(); later(); };
        const end = () => {
            const id = drag?.id;
            drag = undefined;
            if (id !== undefined && thumb.hasPointerCapture(id))
                thumb.releasePointerCapture(id);
            container.classList.remove('dragging');
            thumb.classList.remove('drag', 'is-busy');
            later();
            if (id !== undefined)
                document.body.classList.remove('dragging-scroll');
        };
        const down = (event: PointerEvent) => {
            if (event.button !== 0 || thumb.hidden)
                return;
            event.preventDefault();
            event.stopPropagation();
            const footer = container.querySelector<HTMLElement>(':scope > .settings-footer, :scope > .card-f');
            const track = container.clientHeight - headerHeight() - (footer?.offsetHeight ?? 0) - 8;
            const travel = track - thumb.offsetHeight;
            if (travel <= 0)
                return;
            drag = { id: event.pointerId, y: event.clientY, scroll: container.scrollTop, ratio: (container.scrollHeight - container.clientHeight) / travel };
            thumb.setPointerCapture(event.pointerId);
            show();
            thumb.classList.add('drag', 'is-busy');
            container.classList.add('dragging');
            document.body.classList.add('dragging-scroll');
        };
        const move = (event: PointerEvent) => { if (drag?.id === event.pointerId)
            container.scrollTop = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, drag.scroll + (event.clientY - drag.y) * drag.ratio)); };
        thumb.addEventListener('pointerdown', down);
        thumb.addEventListener('pointermove', move);
        thumb.addEventListener('pointerup', end);
        thumb.addEventListener('pointercancel', end);
        thumb.addEventListener('lostpointercapture', end);
        container.addEventListener('scroll', scroll, { passive: true });
        const resize = new ResizeObserver(update);
        resize.observe(container);
        return { update, dispose() { end(); clearTimeout(timer); cancelAnimationFrame(frame); resize.disconnect(); container.removeEventListener('scroll', scroll); container.removeEventListener('mouseenter', enter); container.removeEventListener('mouseleave', leave); thumb.remove(); } };
    }
    const updateAll = () => { for (const b of bound.values())
        b.update(); };
    document.addEventListener('scroll', updateAll, { capture: true, passive: true });
    window.addEventListener('resize', updateAll);
    scan();
    return () => { disposed = true; observer.disconnect(); document.removeEventListener('scroll', updateAll, true); window.removeEventListener('resize', updateAll); for (const b of bound.values())
        b.dispose(); bound.clear(); layer.remove(); };
}
