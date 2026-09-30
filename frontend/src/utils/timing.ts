/** 简单防抖 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait = 400) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
