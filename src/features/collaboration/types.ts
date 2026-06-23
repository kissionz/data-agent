export type AssetType = 'conversation' | 'verified_case' | 'template' | 'subscription'
export type AssetStatus = 'active' | 'review' | 'archived'
export type ShareScope = 'private' | 'workspace' | 'domain_leads' | 'external_blocked'
export type SubscriptionCadence = 'daily' | 'weekly' | 'threshold' | 'none'

export interface Collaborator {
  name: string
  role: string
}

export interface CollaborationAsset {
  id: string
  title: string
  type: AssetType
  status: AssetStatus
  businessDomain: string
  owner: string
  updatedAt: string
  description: string
  semanticVersion: string
  analysisIrVersion: string
  questionTemplate: string
  scope: string
  isFavorite: boolean
  isArchived: boolean
  shareScope: ShareScope
  subscriptionCadence: SubscriptionCadence
  subscribers: number
  reviewers: Collaborator[]
  lastAudit: string
  watermarkedExport: boolean
}

