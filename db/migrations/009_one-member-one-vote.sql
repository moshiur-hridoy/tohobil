-- Up Migration
-- Owner decision (ASSUMPTIONS 111): every proposal is decided one member, one vote. This sets aside
-- the share-weighted basis of constitution 4.2 for financial matters. Thresholds (majority/unanimous)
-- are unchanged. A proposal copies its policy when it opens, so votes already running keep their basis.
UPDATE proposal_policies SET basis = 'member' WHERE basis = 'share';

-- Down Migration
UPDATE proposal_policies SET basis = 'share'
WHERE type IN ('investment_purchase', 'asset_sale', 'distribution', 'valuation_update', 'financing_arrangement',
               'dissolution', 'wind_up', 'land_selection', 'project_closure');
