// next/navigation outside the application router: router.push is recorded for the browser test.
declare global { interface Window { pushes: string[] } }
window.pushes = [];
export function useRouter() {
  return { push: (href: string) => { window.pushes.push(href); document.getElementById("pushes")!.textContent = window.pushes.join("\n"); },
    replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} };
}
