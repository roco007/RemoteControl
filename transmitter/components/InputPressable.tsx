import React, { useEffect, useMemo, useRef } from 'react';
import { AppState, Platform, Pressable, type PressableProps } from 'react-native';
import { PressLifecycle } from '../services/PressLifecycle';

export type InputPressableProps = Omit<PressableProps, 'onPress' | 'onPressIn' | 'onPressOut' | 'disabled'> & {
  onDown: () => void;
  onUp: () => void;
  enabled?: boolean;
};

function eventMetadata(event: unknown): { type?: string; timestamp?: number; detail?: number } {
  const e = event as { timeStamp?: unknown; nativeEvent?: { type?: unknown; timestamp?: unknown; timeStamp?: unknown; detail?: unknown } };
  const n = e.nativeEvent;
  const timestamp = n?.timeStamp ?? n?.timestamp ?? e.timeStamp;
  return {
    type: typeof n?.type === 'string' ? n.type : undefined,
    timestamp: typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined,
    detail: typeof n?.detail === 'number' ? n.detail : undefined,
  };
}

/** Real press/hold/release plus a complete accessibility activation fallback. */
export function InputPressable({ onDown, onUp, enabled = true, onBlur, onTouchCancel, ...props }: InputPressableProps) {
  const current = useRef({ onDown, onUp, enabled });
  current.current = { onDown, onUp, enabled };
  const lifecycle = useMemo(() => new PressLifecycle({
    onDown: () => current.current.onDown(),
    onUp: () => current.current.onUp(),
    enabled: () => current.current.enabled,
  }), []);

  useEffect(() => { if (!enabled) lifecycle.cancel(); }, [enabled, lifecycle]);
  useEffect(() => {
    const state = AppState.addEventListener('change', value => { if (value !== 'active') lifecycle.cancel(); });
    if (Platform.OS === 'web') globalThis.addEventListener?.('blur', lifecycle.cancel);
    return () => {
      state.remove();
      if (Platform.OS === 'web') globalThis.removeEventListener?.('blur', lifecycle.cancel);
      lifecycle.cancel();
    };
  }, [lifecycle]);

  return <Pressable {...props} disabled={!enabled}
    onPressIn={lifecycle.begin}
    onPressOut={event => {
      const metadata = eventMetadata(event);
      if (metadata.type && ['touchcancel', 'pointercancel', 'selectionchange', 'blur'].includes(metadata.type)) lifecycle.cancel();
      else lifecycle.end({ expectClick: metadata.type !== undefined && ['mouseup', 'touchend', 'keyup', 'pointerup'].includes(metadata.type), timestamp: metadata.timestamp });
    }}
    onPress={event => {
      const metadata = eventMetadata(event);
      lifecycle.activate({ semantic: metadata.type === 'click' && metadata.detail === 0, timestamp: metadata.timestamp });
    }}
    onBlur={event => { lifecycle.cancel(); onBlur?.(event); }}
    onTouchCancel={event => { lifecycle.cancel(); onTouchCancel?.(event); }}
  />;
}
