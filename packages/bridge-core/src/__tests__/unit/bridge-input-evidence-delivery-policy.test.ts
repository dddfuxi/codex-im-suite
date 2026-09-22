import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyInputAttachmentDeliveryPurpose,
  enforceInputEvidenceDeliveryBoundary,
} from '../../lib/bridge/application/input-evidence-delivery-policy.js';
import type { DeliveryCandidatePayload } from '../../lib/bridge/application/delivery-preparation.js';
import type { FileAttachment } from '../../lib/bridge/host.js';

function imageAttachment(filePath = 'C:\\runtime\\inputs\\avatar.png'): FileAttachment {
  return {
    id: 'input-avatar',
    name: 'avatar.png',
    type: 'image/png',
    size: 128,
    data: 'iVBORw0KGgo=',
    filePath,
  };
}

function payload(input: Partial<DeliveryCandidatePayload> = {}): DeliveryCandidatePayload {
  return {
    text: '识别结果：这是一个蓝色头像。',
    parseMode: 'plain',
    images: [],
    files: [],
    ...input,
  };
}

describe('input evidence delivery boundary', () => {
  it('keeps an avatar as recognition evidence instead of replaying it', () => {
    const inputPath = 'C:\\runtime\\inputs\\avatar.png';
    const result = enforceInputEvidenceDeliveryBoundary({
      payload: payload({ images: [inputPath], cardHero: { imagePath: inputPath, alt: '头像' } }),
      userText: '看一下我的头像',
      inputAttachments: [imageAttachment(inputPath)],
      executionRequirementKind: 'input_evidence_required',
    });

    assert.equal(result.purpose, 'inspect_input');
    assert.equal(result.payload.text, '识别结果：这是一个蓝色头像。');
    assert.deepEqual(result.payload.images, []);
    assert.equal(result.payload.cardHero, undefined);
    assert.deepEqual(result.filteredImages, [inputPath]);
  });

  it('does not replay a screenshot that was supplied only for analysis', () => {
    const inputPath = 'C:\\runtime\\inputs\\screen.png';
    const result = enforceInputEvidenceDeliveryBoundary({
      payload: payload({ images: [inputPath] }),
      userText: '识别这张图里有什么，只要说明',
      inputAttachments: [imageAttachment(inputPath)],
      executionRequirementKind: 'input_evidence_required',
    });

    assert.deepEqual(result.payload.images, []);
  });

  it('allows source media when the requested result purpose is to deliver that media', () => {
    const inputPath = 'C:\\runtime\\inputs\\avatar.png';
    for (const userText of [
      '把这张图放到回复里',
      '回复结果里需要带上原图',
      '我想要这个附件',
      'return this image to me',
    ]) {
      const result = enforceInputEvidenceDeliveryBoundary({
        payload: payload({ images: [inputPath] }),
        userText,
        inputAttachments: [imageAttachment(inputPath)],
        executionRequirementKind: 'input_evidence_required',
      });
      assert.equal(result.purpose, 'deliver_input', userText);
      assert.deepEqual(result.payload.images, [inputPath], userText);
    }
  });

  it('does not treat a negated image delivery as authorization', () => {
    assert.notEqual(classifyInputAttachmentDeliveryPurpose('不要把图片发出来，只识别内容'), 'deliver_input');
    assert.notEqual(classifyInputAttachmentDeliveryPurpose('我希望它是识别，而不是给我放出来，我没要求'), 'deliver_input');
    assert.equal(classifyInputAttachmentDeliveryPurpose('不要只识别，把图发出来'), 'deliver_input');
    assert.equal(classifyInputAttachmentDeliveryPurpose('不要编辑，直接把原图给我'), 'deliver_input');
    assert.equal(classifyInputAttachmentDeliveryPurpose('不要发旧图，把这张图放到回复里'), 'deliver_input');
  });

  it('keeps a newly edited output while removing the exact source input', () => {
    const inputPath = 'C:\\runtime\\inputs\\avatar.png';
    const outputPath = 'C:\\runtime\\artifacts\\avatar-edited.png';
    const result = enforceInputEvidenceDeliveryBoundary({
      payload: payload({ images: [inputPath, outputPath] }),
      userText: '编辑这张图后作为结果给我',
      inputAttachments: [imageAttachment(inputPath)],
      executionRequirementKind: 'artifact_required',
    });

    assert.equal(result.purpose, 'produce_output');
    assert.deepEqual(result.payload.images, [outputPath]);
  });

  it('filters a basename alias during read-only inspection', () => {
    const result = enforceInputEvidenceDeliveryBoundary({
      payload: payload({ images: ['C:\\workspace\\avatar.png'] }),
      userText: '描述一下头像',
      inputAttachments: [imageAttachment('C:\\runtime\\inputs\\avatar.png')],
      executionRequirementKind: 'input_evidence_required',
    });

    assert.deepEqual(result.payload.images, []);
  });

  it('does not remove a same-named new artifact from a transform turn', () => {
    const outputPath = 'C:\\runtime\\artifacts\\avatar.png';
    const result = enforceInputEvidenceDeliveryBoundary({
      payload: payload({ images: [outputPath] }),
      userText: '编辑后把结果给我',
      inputAttachments: [imageAttachment('C:\\runtime\\inputs\\avatar.png')],
      executionRequirementKind: 'artifact_required',
    });

    assert.deepEqual(result.payload.images, [outputPath]);
  });

  it('leaves unrelated output files unchanged', () => {
    const reportPath = 'C:\\runtime\\artifacts\\report.md';
    const result = enforceInputEvidenceDeliveryBoundary({
      payload: payload({ files: [reportPath] }),
      userText: '分析图片并输出报告',
      inputAttachments: [imageAttachment()],
      executionRequirementKind: 'artifact_required',
    });

    assert.deepEqual(result.payload.files, [reportPath]);
  });
});
