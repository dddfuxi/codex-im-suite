type CardKitCall = (payload: unknown) => Promise<unknown>;
type CardKitCreateCall = (payload: unknown) => Promise<{ data?: { card_id?: string } }>;

export type FeishuCardKitCompat =
  | {
    version: 'v2';
    card: {
      create: CardKitCreateCall;
      streamContent: CardKitCall;
      update: CardKitCall;
      settings?: {
        streamingMode?: {
          set?: CardKitCall;
        };
      };
    };
  }
  | {
    version: 'v1';
    card: {
      create: CardKitCreateCall;
      update: CardKitCall;
      settings: CardKitCall;
    };
    cardElement: {
      content: CardKitCall;
    };
  };

function isCall(value: unknown): value is CardKitCall {
  return typeof value === 'function';
}

/**
 * 兼容当前飞书 SDK 暴露的 CardKit v2/v1 结构，优先使用 v2。
 * 这里只接受完整能力面，避免 adapter 在运行中调用到缺失方法。
 */
export function resolveFeishuCardKitCompat(client: unknown): FeishuCardKitCompat | null {
  const cardkit = (client as { cardkit?: any } | null | undefined)?.cardkit;
  const v2Card = cardkit?.v2?.card;
  if (isCall(v2Card?.create) && isCall(v2Card?.streamContent) && isCall(v2Card?.update)) {
    return { version: 'v2', card: v2Card };
  }

  const v1Card = cardkit?.v1?.card;
  const v1CardElement = cardkit?.v1?.cardElement;
  if (
    isCall(v1Card?.create)
    && isCall(v1Card?.update)
    && isCall(v1Card?.settings)
    && isCall(v1CardElement?.content)
  ) {
    return { version: 'v1', card: v1Card, cardElement: v1CardElement };
  }
  return null;
}

export function createFeishuCardKitCard(
  cardKit: FeishuCardKitCompat,
  cardBody: Record<string, unknown>,
): Promise<{ data?: { card_id?: string } }> {
  return cardKit.card.create({
    data: { type: 'card_json', data: JSON.stringify(cardBody) },
  });
}

export function updateFeishuCardKitStreamingContent(
  cardKit: FeishuCardKitCompat,
  cardId: string,
  content: string,
  sequence: number,
): Promise<unknown> {
  if (cardKit.version === 'v2') {
    return cardKit.card.streamContent({
      path: { card_id: cardId },
      data: { content, sequence },
    });
  }
  return cardKit.cardElement.content({
    path: { card_id: cardId, element_id: 'streaming_content' },
    data: { content, sequence },
  });
}

export function setFeishuCardKitStreamingMode(
  cardKit: FeishuCardKitCompat,
  cardId: string,
  streamingMode: boolean,
  sequence: number,
): Promise<unknown> {
  if (cardKit.version === 'v2' && cardKit.card.settings?.streamingMode?.set) {
    return cardKit.card.settings.streamingMode.set({
      path: { card_id: cardId },
      data: { streaming_mode: streamingMode, sequence },
    });
  }
  if (cardKit.version === 'v1') {
    return cardKit.card.settings({
      path: { card_id: cardId },
      data: {
        settings: JSON.stringify({ streaming_mode: streamingMode }),
        sequence,
      },
    });
  }
  return Promise.resolve();
}

export function updateFeishuCardKitCard(
  cardKit: FeishuCardKitCompat,
  cardId: string,
  finalCardJson: string,
  sequence: number,
): Promise<unknown> {
  if (cardKit.version === 'v2') {
    return cardKit.card.update({
      path: { card_id: cardId },
      data: { type: 'card_json', data: finalCardJson, sequence },
    });
  }
  return cardKit.card.update({
    path: { card_id: cardId },
    data: {
      card: { type: 'card_json', data: finalCardJson },
      sequence,
    },
  });
}
