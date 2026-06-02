import { useCallback, useEffect, useRef } from "react";

export function useMountedRef() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

export function useTimeoutRegistry() {
  const timersRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  return useCallback((callback: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      callback();
    }, delay);
    timersRef.current.add(timer);
    return timer;
  }, []);
}

export function useAnimationFrameRegistry() {
  const framesRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    return () => {
      framesRef.current.forEach((frame) => window.cancelAnimationFrame(frame));
      framesRef.current.clear();
    };
  }, []);

  return useCallback((callback: FrameRequestCallback) => {
    const frame = window.requestAnimationFrame((timestamp) => {
      framesRef.current.delete(frame);
      callback(timestamp);
    });
    framesRef.current.add(frame);
    return frame;
  }, []);
}
