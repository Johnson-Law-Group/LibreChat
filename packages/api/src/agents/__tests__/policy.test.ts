import { modelPolicySchema } from 'librechat-data-provider';
import { applyModelPolicy, resolveModelAlias } from '../policy';

const policy = {
  maxContextTokens: 64_000,
  aliases: { JLG: { 'gpt-5.4': 'gpt-5.6-terra', 'gpt-5.6-terra': 'gpt-6.1-sol' } },
};

describe('server model policy', () => {
  it('resolves successive retirements and scopes aliases to the configured endpoint', () => {
    expect(resolveModelAlias('gpt-5.4', 'JLG', policy)).toBe('gpt-6.1-sol');
    expect(resolveModelAlias('gpt-5.4', 'openAI', policy)).toBe('gpt-5.4');
    expect(resolveModelAlias('gemini-3-flash', 'JLG', policy)).toBe('gemini-3-flash');
  });

  it.each([400_000, undefined, null, -1, Number.NaN, '400000'])(
    'caps legacy or invalid context settings: %s',
    (maxContextTokens) => {
      const result = applyModelPolicy({ model: 'gpt-5.4', maxContextTokens }, 'JLG', policy);
      expect(result).toEqual({ model: 'gpt-6.1-sol', maxContextTokens: 64_000 });
    },
  );

  it('preserves smaller budgets and does not mutate the request', () => {
    const request = { model: 'gpt-5.4', maxContextTokens: 32_000 };
    expect(applyModelPolicy(request, 'JLG', policy)).toEqual({
      model: 'gpt-6.1-sol',
      maxContextTokens: 32_000,
    });
    expect(request.model).toBe('gpt-5.4');
    expect(applyModelPolicy(request, 'JLG')).toBe(request);
  });

  it('rejects cycles both at configuration load and runtime', () => {
    const cyclic = { aliases: { JLG: { old: 'new', new: 'old' } } };
    expect(modelPolicySchema.safeParse(cyclic).success).toBe(false);
    expect(() => resolveModelAlias('old', 'JLG', cyclic)).toThrow('Cyclic model alias');
    expect(modelPolicySchema.safeParse({ maxContextTokens: 0 }).success).toBe(false);
  });
});
