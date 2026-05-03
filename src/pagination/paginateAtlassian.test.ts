/**
 * Tests for paginateAtlassian — shared pagination utility.
 *
 * Covers all three termination conditions and reconciliation logic.
 */

import { paginateAtlassian } from './paginateAtlassian';

describe('paginateAtlassian', () => {
  // ── Termination condition 1: empty results ──────────────────────────────────

  describe('termination condition 1 — empty results', () => {
    it('terminates immediately on first empty page', async () => {
      const fetchPage = jest
        .fn()
        .mockResolvedValue({ values: [], total: 10, isLast: false });

      const result = await paginateAtlassian(fetchPage, 5);

      expect(result.items).toHaveLength(0);
      expect(result.totalFetched).toBe(0);
      expect(result.pagesFetched).toBe(1);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('terminates on empty values key', async () => {
      const fetchPage = jest.fn().mockResolvedValue({ values: [] });
      const result = await paginateAtlassian(fetchPage, 50);
      expect(result.items).toHaveLength(0);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('terminates on empty issues key (search/jql endpoint)', async () => {
      const fetchPage = jest.fn().mockResolvedValue({ issues: [] });
      const result = await paginateAtlassian(fetchPage, 50);
      expect(result.items).toHaveLength(0);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });
  });

  // ── Termination condition 2: isLast === true ────────────────────────────────

  describe('termination condition 2 — isLast === true', () => {
    it('terminates when isLast is true even if page is full', async () => {
      const fetchPage = jest.fn().mockResolvedValue({
        values: [{ id: '1' }, { id: '2' }, { id: '3' }],
        total: 3,
        isLast: true,
      });

      const result = await paginateAtlassian(fetchPage, 3);

      expect(result.items).toHaveLength(3);
      expect(result.pagesFetched).toBe(1);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('terminates mid-stream when isLast becomes true', async () => {
      const fetchPage = jest
        .fn()
        .mockResolvedValueOnce({
          values: [{ id: '1' }, { id: '2' }],
          total: 4,
          isLast: false,
        })
        .mockResolvedValueOnce({
          values: [{ id: '3' }, { id: '4' }],
          total: 4,
          isLast: true,
        });

      const result = await paginateAtlassian(fetchPage, 2);

      expect(result.items).toHaveLength(4);
      expect(result.pagesFetched).toBe(2);
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });
  });

  // ── Termination condition 3: partial page ───────────────────────────────────

  describe('termination condition 3 — partial page (results.length < maxResults)', () => {
    it('terminates when first page is partial', async () => {
      const fetchPage = jest.fn().mockResolvedValue({
        values: [{ id: '1' }, { id: '2' }],
        total: 2,
        isLast: false, // isLast not set — must terminate on partial
      });

      const result = await paginateAtlassian(fetchPage, 5);

      expect(result.items).toHaveLength(2);
      expect(result.pagesFetched).toBe(1);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('paginates across full pages and terminates on final partial page', async () => {
      const fetchPage = jest
        .fn()
        .mockResolvedValueOnce({
          values: [{ id: '1' }, { id: '2' }],
          total: 5,
          isLast: false,
        })
        .mockResolvedValueOnce({
          values: [{ id: '3' }, { id: '4' }],
          total: 5,
          isLast: false,
        })
        .mockResolvedValueOnce({
          values: [{ id: '5' }],
          total: 5,
          isLast: false,
        }); // partial — terminates

      const result = await paginateAtlassian(fetchPage, 2);

      expect(result.items).toHaveLength(5);
      expect(result.pagesFetched).toBe(3);
      expect(result.totalFetched).toBe(5);
      expect(result.apiReportedTotal).toBe(5);
      expect(result.reconciled).toBe(true);
    });

    it('does not fetch another page when first page exactly fills maxResults AND isLast unset but total matches', async () => {
      // 3 items, maxResults=3, no isLast → would normally continue.
      // But apiReportedTotal=3 and items.length >= apiReportedTotal → stops.
      const fetchPage = jest.fn().mockResolvedValue({
        values: [{ id: '1' }, { id: '2' }, { id: '3' }],
        total: 3,
        isLast: false,
      });

      const result = await paginateAtlassian(fetchPage, 3);

      // Terminates because items.length >= apiReportedTotal
      expect(result.pagesFetched).toBe(1);
      expect(result.items).toHaveLength(3);
    });
  });

  // ── Reconciliation ──────────────────────────────────────────────────────────

  describe('reconciliation', () => {
    it('sets reconciled=true when totalFetched === apiReportedTotal', async () => {
      const fetchPage = jest.fn().mockResolvedValue({
        values: [{ id: '1' }, { id: '2' }],
        total: 2,
        isLast: true,
      });

      const result = await paginateAtlassian(fetchPage, 50);

      expect(result.reconciled).toBe(true);
      expect(result.gap).toBeUndefined();
    });

    it('sets reconciled=false and computes gap when totalFetched < apiReportedTotal', async () => {
      // API says 5 total but isLast=true after 3 → reconciliation gap
      const fetchPage = jest.fn().mockResolvedValue({
        values: [{ id: '1' }, { id: '2' }, { id: '3' }],
        total: 5,
        isLast: true,
      });

      const result = await paginateAtlassian(fetchPage, 50);

      expect(result.reconciled).toBe(false);
      expect(result.gap).toBe(2); // 5 - 3
    });

    it('sets reconciled=true when apiReportedTotal is null (endpoint has no total)', async () => {
      // No total field — cannot detect gap → treat as reconciled
      const fetchPage = jest.fn().mockResolvedValue({
        values: [{ id: '1' }],
        // no total
      });

      const result = await paginateAtlassian(fetchPage, 50);

      expect(result.reconciled).toBe(true);
      expect(result.apiReportedTotal).toBeNull();
      expect(result.gap).toBeUndefined();
    });
  });

  // ── Issues key (search/jql) ─────────────────────────────────────────────────

  describe('issues key (POST /rest/api/3/search/jql)', () => {
    it('reads items from the issues key', async () => {
      const fetchPage = jest.fn().mockResolvedValue({
        issues: [{ id: 'PROJ-1' }, { id: 'PROJ-2' }],
        total: 2,
      });

      const result = await paginateAtlassian(fetchPage, 50);

      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toEqual({ id: 'PROJ-1' });
    });
  });

  // ── startAt advancement ─────────────────────────────────────────────────────

  describe('startAt advancement', () => {
    it('passes correct startAt on each page call', async () => {
      const fetchPage = jest
        .fn()
        .mockResolvedValueOnce({
          values: [{ id: '1' }, { id: '2' }],
          total: 3,
          isLast: false,
        })
        .mockResolvedValueOnce({
          values: [{ id: '3' }],
          total: 3,
          isLast: false,
        });

      await paginateAtlassian(fetchPage, 2);

      expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 2);
      expect(fetchPage).toHaveBeenNthCalledWith(2, 2, 2);
    });

    it('passes the provided maxResults to each fetchPage call', async () => {
      const fetchPage = jest.fn().mockResolvedValue({
        values: [],
        isLast: true,
      });

      await paginateAtlassian(fetchPage, 25);

      expect(fetchPage).toHaveBeenCalledWith(0, 25);
    });
  });

  // ── Single-page adapter (flat-array endpoints) ──────────────────────────────

  describe('single-page adapter for flat-array endpoints', () => {
    it('terminates immediately when isLast is forced to true in adapter', async () => {
      const flatArray = [{ id: '1' }, { id: '2' }, { id: '3' }];
      const fetchPage = jest.fn().mockResolvedValue({
        values: flatArray,
        total: flatArray.length,
        isLast: true, // forced by adapter
      });

      const result = await paginateAtlassian(fetchPage, 50);

      expect(result.items).toHaveLength(3);
      expect(result.pagesFetched).toBe(1);
      expect(result.reconciled).toBe(true);
    });
  });
});
