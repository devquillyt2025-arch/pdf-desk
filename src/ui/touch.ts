/** The main pointer is a finger (a phone or tablet), not a mouse: help text says "tap", and keyboard hints are left out. */
export const TOUCH = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
