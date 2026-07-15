import React from 'react';
import { FormField, Header } from '@cloudscape-design/components';
import { HelpButton } from './utils/HelpButton';
import { useLanguage } from '../contexts/LanguageContext';
import { WellArchitectedPillar, LensMetadata } from '../types';

interface PillarSelectorProps {
  pillars: WellArchitectedPillar[];
  selectedPillars: string[];
  onChange: (selectedPillarIds: string[]) => void;
  selectedLens?: LensMetadata;
}

export const PillarSelector: React.FC<PillarSelectorProps> = ({
  selectedLens
}) => {
  const { strings } = useLanguage();

  // Determine the header text based on selected lens
  const headerText= selectedLens 
    ? `2. ${strings.pillarSelector.selectPillars} (${selectedLens.lensName})`
    : `2. ${strings.pillarSelector.selectPillars}`;

  return (
    <FormField
      label={
        <>
          <Header variant="h3">
            {headerText} <HelpButton contentId="pillarSelection" />
          </Header>
        </>
      }
    >
      <select>
        <option value="SOR">SaaS Operational Resilience</option>
      </select>
    </FormField>
  );
};
