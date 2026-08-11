import { SectionConfigService } from '../../src/services/SectionConfigService'

describe('SectionConfigService', () => {
  describe('constructor / defaults', () => {
    it('uses default boundaries when no customSections provided', () => {
      const svc = new SectionConfigService()
      expect(svc.getSlotKeys()).toEqual([
        '0:00-8:00',
        '8:00-12:00',
        '12:00-16:00',
        '16:00-0:00',
      ])
    })

    it('uses custom boundaries when valid customSections provided', () => {
      const svc = new SectionConfigService([
        { hour: 0, minute: 0 },
        { hour: 6, minute: 0 },
        { hour: 12, minute: 0 },
        { hour: 18, minute: 0 },
      ])
      expect(svc.getSlotKeys()).toEqual([
        '0:00-6:00',
        '6:00-12:00',
        '12:00-18:00',
        '18:00-0:00',
      ])
    })

    it('falls back to defaults for invalid customSections', () => {
      const svc = new SectionConfigService([{ hour: 5, minute: 0 }]) // too few
      expect(svc.getSlotKeys()).toEqual([
        '0:00-8:00',
        '8:00-12:00',
        '12:00-16:00',
        '16:00-0:00',
      ])
    })

    it('falls back to defaults when first boundary is not midnight', () => {
      const svc = new SectionConfigService([
        { hour: 1, minute: 0 },
        { hour: 8, minute: 0 },
        { hour: 12, minute: 0 },
      ])
      expect(svc.getSlotKeys()).toEqual([
        '0:00-8:00',
        '8:00-12:00',
        '12:00-16:00',
        '16:00-0:00',
      ])
    })
  })

  describe('sanitizeBoundaries', () => {
    it('returns undefined for non-array', () => {
      expect(SectionConfigService.sanitizeBoundaries('invalid')).toBeUndefined()
      expect(SectionConfigService.sanitizeBoundaries(null)).toBeUndefined()
      expect(SectionConfigService.sanitizeBoundaries(42)).toBeUndefined()
    })

    it('returns undefined for fewer than 2 items', () => {
      expect(SectionConfigService.sanitizeBoundaries([{ hour: 0, minute: 0 }])).toBeUndefined()
      expect(SectionConfigService.sanitizeBoundaries([])).toBeUndefined()
    })

    it('returns undefined for out-of-range values', () => {
      expect(SectionConfigService.sanitizeBoundaries([
        { hour: 0, minute: 0 },
        { hour: 25, minute: 0 },
      ])).toBeUndefined()
      expect(SectionConfigService.sanitizeBoundaries([
        { hour: 0, minute: -1 },
        { hour: 8, minute: 0 },
      ])).toBeUndefined()
    })

    it('returns undefined for non-ascending order', () => {
      expect(SectionConfigService.sanitizeBoundaries([
        { hour: 12, minute: 0 },
        { hour: 8, minute: 0 },
      ])).toBeUndefined()
    })

    it('returns undefined for duplicate boundaries', () => {
      expect(SectionConfigService.sanitizeBoundaries([
        { hour: 0, minute: 0 },
        { hour: 8, minute: 0 },
        { hour: 8, minute: 0 },
      ])).toBeUndefined()
    })

    it('returns undefined for non-integer values', () => {
      expect(SectionConfigService.sanitizeBoundaries([
        { hour: 0, minute: 0 },
        { hour: 8.5, minute: 0 },
      ])).toBeUndefined()
    })

    it('returns boundaries for valid input', () => {
      const result = SectionConfigService.sanitizeBoundaries([
        { hour: 0, minute: 0 },
        { hour: 8, minute: 30 },
      ])
      expect(result).toEqual([
        { hour: 0, minute: 0 },
        { hour: 8, minute: 30 },
      ])
    })

    it('returns undefined when first boundary is not 00:00', () => {
      expect(SectionConfigService.sanitizeBoundaries([
        { hour: 1, minute: 0 },
        { hour: 8, minute: 0 },
      ])).toBeUndefined()
    })
  })

  describe('getSlotFromTime', () => {
    const svc = new SectionConfigService()

    it('returns correct slot for HH:MM format', () => {
      expect(svc.getSlotFromTime('07:30')).toBe('0:00-8:00')
      expect(svc.getSlotFromTime('08:00')).toBe('8:00-12:00')
      expect(svc.getSlotFromTime('11:59')).toBe('8:00-12:00')
      expect(svc.getSlotFromTime('12:00')).toBe('12:00-16:00')
      expect(svc.getSlotFromTime('16:00')).toBe('16:00-0:00')
      expect(svc.getSlotFromTime('23:59')).toBe('16:00-0:00')
    })

    it('handles H:MM format (no zero-padding)', () => {
      expect(svc.getSlotFromTime('8:30')).toBe('8:00-12:00')
      expect(svc.getSlotFromTime('0:00')).toBe('0:00-8:00')
    })

    it('handles HH:MM:SS format (seconds truncated)', () => {
      expect(svc.getSlotFromTime('08:30:45')).toBe('8:00-12:00')
      expect(svc.getSlotFromTime('8:30:45')).toBe('8:00-12:00')
    })

    it('handles ISO 8601 format', () => {
      expect(svc.getSlotFromTime('2026-02-08T08:30:00')).toBe('8:00-12:00')
      const utcIso = '2026-02-08T16:00:00Z'
      expect(svc.getSlotFromTime(utcIso)).toBe(svc.getCurrentTimeSlot(new Date(utcIso)))
    })

    it('handles milliseconds in time strings', () => {
      expect(svc.getSlotFromTime('08:30:00.000')).toBe('8:00-12:00')
      expect(svc.getSlotFromTime('08:30:00.000Z')).toBe('8:00-12:00')
      const isoWithOffset = '2026-02-08T16:00:00.123+09:00'
      expect(svc.getSlotFromTime(isoWithOffset)).toBe(
        svc.getCurrentTimeSlot(new Date(isoWithOffset)),
      )
    })

    it('returns first slot for invalid input', () => {
      expect(svc.getSlotFromTime('invalid')).toBe('0:00-8:00')
      expect(svc.getSlotFromTime('')).toBe('0:00-8:00')
    })
  })

  describe('getSlotFromTime with minute-precision boundaries', () => {
    const svc = new SectionConfigService([
      { hour: 0, minute: 0 },
      { hour: 8, minute: 30 },
      { hour: 12, minute: 0 },
      { hour: 16, minute: 0 },
    ])

    it('correctly classifies at minute-precision boundary', () => {
      expect(svc.getSlotFromTime('08:29')).toBe('0:00-8:30')
      expect(svc.getSlotFromTime('08:30')).toBe('8:30-12:00')
      expect(svc.getSlotFromTime('08:31')).toBe('8:30-12:00')
    })
  })

  describe('getCurrentTimeSlot', () => {
    const svc = new SectionConfigService()

    it('returns correct slot for given date', () => {
      const morning = new Date(2026, 1, 8, 7, 0, 0)
      expect(svc.getCurrentTimeSlot(morning)).toBe('0:00-8:00')

      const noon = new Date(2026, 1, 8, 12, 0, 0)
      expect(svc.getCurrentTimeSlot(noon)).toBe('12:00-16:00')

      const evening = new Date(2026, 1, 8, 20, 0, 0)
      expect(svc.getCurrentTimeSlot(evening)).toBe('16:00-0:00')
    })
  })

  describe('calculateSlotKeyFromTime', () => {
    const svc = new SectionConfigService()

    it('returns undefined for empty/null input', () => {
      expect(svc.calculateSlotKeyFromTime(undefined)).toBeUndefined()
      expect(svc.calculateSlotKeyFromTime('')).toBeUndefined()
    })

    it('returns slot key for valid time', () => {
      expect(svc.calculateSlotKeyFromTime('08:30')).toBe('8:00-12:00')
      expect(svc.calculateSlotKeyFromTime('00:00')).toBe('0:00-8:00')
    })

    it('returns slot key for valid millisecond timestamps', () => {
      expect(svc.calculateSlotKeyFromTime('08:30:00.000')).toBe('8:00-12:00')
      expect(svc.calculateSlotKeyFromTime('08:30:00.000Z')).toBe('8:00-12:00')
    })

    it('treats equivalent ISO instants with different offsets as the same slot', () => {
      const utcInstant = '2026-02-08T00:30:00Z'
      const offsetInstant = '2026-02-08T09:30:00+09:00'

      expect(new Date(utcInstant).getTime()).toBe(new Date(offsetInstant).getTime())
      expect(svc.calculateSlotKeyFromTime(offsetInstant)).toBe(svc.calculateSlotKeyFromTime(utcInstant))
    })
  })

  describe('getTimeBoundaries', () => {
    it('returns boundaries as TimeBoundary[]', () => {
      const svc = new SectionConfigService()
      expect(svc.getTimeBoundaries()).toEqual([
        { hour: 0, minute: 0 },
        { hour: 8, minute: 0 },
        { hour: 12, minute: 0 },
        { hour: 16, minute: 0 },
      ])
    })
  })

  describe('getSlotStartTime', () => {
    const svc = new SectionConfigService()

    it('returns start time for valid slot key', () => {
      expect(svc.getSlotStartTime('0:00-8:00')).toBe('00:00')
      expect(svc.getSlotStartTime('8:00-12:00')).toBe('08:00')
      expect(svc.getSlotStartTime('16:00-0:00')).toBe('16:00')
    })

    it('returns null for none', () => {
      expect(svc.getSlotStartTime('none')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(svc.getSlotStartTime('')).toBeNull()
    })
  })

  describe('isValidSlotKey', () => {
    const svc = new SectionConfigService()

    it('returns true for valid slot keys', () => {
      expect(svc.isValidSlotKey('0:00-8:00')).toBe(true)
      expect(svc.isValidSlotKey('8:00-12:00')).toBe(true)
      expect(svc.isValidSlotKey('none')).toBe(true)
    })

    it('returns false for invalid slot keys', () => {
      expect(svc.isValidSlotKey('5:00-10:00')).toBe(false)
      expect(svc.isValidSlotKey('invalid')).toBe(false)
    })
  })

  describe('migrateSlotKey', () => {
    it('returns none for none', () => {
      const svc = new SectionConfigService()
      expect(svc.migrateSlotKey('none')).toBe('none')
    })

    it('returns same key if valid', () => {
      const svc = new SectionConfigService()
      expect(svc.migrateSlotKey('8:00-12:00')).toBe('8:00-12:00')
    })

    it('migrates old key to new slot', () => {
      const svc = new SectionConfigService([
        { hour: 0, minute: 0 },
        { hour: 6, minute: 0 },
        { hour: 12, minute: 0 },
        { hour: 18, minute: 0 },
      ])
      // Old key "8:00-12:00" → start time 8:00 → falls in 6:00-12:00
      expect(svc.migrateSlotKey('8:00-12:00')).toBe('6:00-12:00')
      // Old key "16:00-0:00" → start time 16:00 → falls in 12:00-18:00
      expect(svc.migrateSlotKey('16:00-0:00')).toBe('12:00-18:00')
    })

    it('returns none for key without dash', () => {
      const svc = new SectionConfigService()
      expect(svc.migrateSlotKey('invalid')).toBe('none')
    })
  })

  describe('migrateOrderKey', () => {
    it('returns same key if no :: separator', () => {
      const svc = new SectionConfigService()
      expect(svc.migrateOrderKey('simplekey')).toBe('simplekey')
    })

    it('migrates slot part of order key', () => {
      const svc = new SectionConfigService([
        { hour: 0, minute: 0 },
        { hour: 6, minute: 0 },
        { hour: 12, minute: 0 },
        { hour: 18, minute: 0 },
      ])
      expect(svc.migrateOrderKey('task123::8:00-12:00')).toBe('task123::6:00-12:00')
    })

    it('preserves valid slot part', () => {
      const svc = new SectionConfigService()
      expect(svc.migrateOrderKey('task123::8:00-12:00')).toBe('task123::8:00-12:00')
    })
  })

  describe('updateBoundaries', () => {
    it('updates slot keys after boundary change', () => {
      const svc = new SectionConfigService()
      expect(svc.getSlotKeys()).toHaveLength(4)

      svc.updateBoundaries([
        { hour: 0, minute: 0 },
        { hour: 10, minute: 0 },
        { hour: 20, minute: 0 },
      ])
      expect(svc.getSlotKeys()).toEqual([
        '0:00-10:00',
        '10:00-20:00',
        '20:00-0:00',
      ])
    })

    it('reverts to defaults for undefined', () => {
      const svc = new SectionConfigService([
        { hour: 0, minute: 0 },
        { hour: 10, minute: 0 },
      ])
      svc.updateBoundaries(undefined)
      expect(svc.getSlotKeys()).toEqual([
        '0:00-8:00',
        '8:00-12:00',
        '12:00-16:00',
        '16:00-0:00',
      ])
    })
  })

  describe('collision resolution in order migration', () => {
    it('both meta: newer updatedAt wins', () => {
      const svc = new SectionConfigService([
        { hour: 0, minute: 0 },
        { hour: 12, minute: 0 },
      ])
      // "8:00-12:00" and "12:00-16:00" both migrate to "0:00-12:00"
      // Simulate via migrateSlotKey
      expect(svc.migrateSlotKey('8:00-12:00')).toBe('0:00-12:00')
      expect(svc.migrateSlotKey('12:00-16:00')).toBe('12:00-0:00')
    })
  })

  describe('isValidSlotKey with custom boundaries', () => {
    it('old default keys become invalid after boundary change', () => {
      const svc = new SectionConfigService([
        { hour: 0, minute: 0 },
        { hour: 9, minute: 0 },
        { hour: 12, minute: 0 },
        { hour: 16, minute: 50 },
      ])
      // Old default keys are invalid
      expect(svc.isValidSlotKey('0:00-8:00')).toBe(false)
      expect(svc.isValidSlotKey('8:00-12:00')).toBe(false)
      expect(svc.isValidSlotKey('12:00-16:00')).toBe(false)
      expect(svc.isValidSlotKey('16:00-0:00')).toBe(false)
      // New keys are valid
      expect(svc.isValidSlotKey('0:00-9:00')).toBe(true)
      expect(svc.isValidSlotKey('9:00-12:00')).toBe(true)
      expect(svc.isValidSlotKey('12:00-16:50')).toBe(true)
      expect(svc.isValidSlotKey('16:50-0:00')).toBe(true)
      expect(svc.isValidSlotKey('none')).toBe(true)
    })

    it('getCurrentTimeSlot uses local Date for correct boundary mapping', () => {
      const svc = new SectionConfigService([
        { hour: 0, minute: 0 },
        { hour: 9, minute: 0 },
        { hour: 12, minute: 0 },
        { hour: 16, minute: 50 },
      ])
      // 18:00 local time → 16:50-0:00
      const evening = new Date(2026, 1, 8, 18, 0, 0)
      expect(svc.getCurrentTimeSlot(evening)).toBe('16:50-0:00')
      // 16:49 local time → 12:00-16:50
      const afternoon = new Date(2026, 1, 8, 16, 49, 0)
      expect(svc.getCurrentTimeSlot(afternoon)).toBe('12:00-16:50')
      // 16:50 local time → 16:50-0:00
      const boundary = new Date(2026, 1, 8, 16, 50, 0)
      expect(svc.getCurrentTimeSlot(boundary)).toBe('16:50-0:00')
    })
  })
})
