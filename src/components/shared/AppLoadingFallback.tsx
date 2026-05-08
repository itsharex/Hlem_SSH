export function AppLoadingFallback() {
  return (
    <div className="appLoadingFallback">
      <img className="bootMark" src="./nexus_icon.svg" alt="" aria-hidden="true" />
      <span>正在加载工作区...</span>
    </div>
  );
}
