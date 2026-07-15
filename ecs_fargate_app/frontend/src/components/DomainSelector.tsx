import React, { useEffect, useState } from 'react';
import { Select, FormField, Spinner, SelectProps } from '@cloudscape-design/components';
import { HelpButton } from './utils/HelpButton';
import { analyzerApi } from '../services/api';

interface DomainMetadata {
  id: string;
  name: string;
  description: string;
  pillars: string[];
}

interface DomainSelectorProps {
  value: string;
  onChange: (value: string, domainMetadata: DomainMetadata) => void;
  disabled?: boolean;
}

// IDs that belong to the "Maturity Assessments" group
const MATURITY_ASSESSMENT_IDS = new Set(['saas_maturity_assessment']);

export const DomainSelector: React.FC<DomainSelectorProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const [groupedOptions, setGroupedOptions] = useState<SelectProps.Options>([]);
  const [flatOptions, setFlatOptions] = useState<SelectProps.Option[]>([]);
  const [domainMetadataMap, setDomainMetadataMap] = useState<Record<string, DomainMetadata>>({});
  const [error, setError] = useState<string | null>(null);

  // Get domain metadata on component mount
  useEffect(() => {
    const fetchDomainMetadata = async () => {
      setIsLoading(true);
      try {
        const domainMetadata = await analyzerApi.getDomainMetadata();

        // Create map for easy lookup
        const metadataMap = domainMetadata.reduce<Record<string, DomainMetadata>>(
          (map, domain) => {
            map[domain.id] = domain;
            return map;
          },
          {}
        );

        // Separate into lens reviews and maturity assessments
        const lensReviews = domainMetadata
          .filter(d => !MATURITY_ASSESSMENT_IDS.has(d.id))
          .sort((a, b) => a.name.localeCompare(b.name));

        const maturityAssessments = domainMetadata
          .filter(d => MATURITY_ASSESSMENT_IDS.has(d.id))
          .sort((a, b) => a.name.localeCompare(b.name));

        const toOption = (domain: DomainMetadata): SelectProps.Option => ({
          label: domain.name,
          value: domain.id,
          description: domain.description,
        });

        // Build grouped options for the Select component
        const groups: (SelectProps.Option | SelectProps.OptionGroup)[] = [];

        if (lensReviews.length > 0) {
          groups.push({
            label: 'Well-Architected Lens Reviews',
            options: lensReviews.map(toOption),
          });
        }

        if (maturityAssessments.length > 0) {
          groups.push({
            label: 'Maturity Assessments',
            options: maturityAssessments.map(toOption),
          });
        }

        // Flat list for selectedOption lookup
        const allOptions = [...lensReviews, ...maturityAssessments].map(toOption);

        setGroupedOptions(groups);
        setFlatOptions(allOptions);
        setDomainMetadataMap(metadataMap);

        // If no domain is selected yet, default to first lens review
        if (!value && allOptions.length > 0) {
          const defaultOption = lensReviews.length > 0 ? toOption(lensReviews[0]) : allOptions[0];
          if (defaultOption.value) {
            onChange(defaultOption.value, metadataMap[defaultOption.value]);
          }
        }

      } catch (error) {
        console.error('Failed to fetch domain metadata:', error);
        setError('Failed to load assessment options. Please refresh the page and try again.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchDomainMetadata();
  }, []);

  const handleDomainChange: SelectProps['onChange'] = ({ detail }) => {
    if (detail.selectedOption && typeof detail.selectedOption.value === 'string') {
      onChange(detail.selectedOption.value, domainMetadataMap[detail.selectedOption.value]);
    }
  };

  return (
    <FormField
      label={
        <>
          Select Assessment Type <HelpButton contentId="domainSelection" />
        </>
      }
      description="Choose a Well-Architected lens review or maturity assessment"
      errorText={error}
    >
      {isLoading ? (
        <Spinner size="normal" />
      ) : (
        <Select
          selectedOption={flatOptions.find(option => option.value === value) || null}
          onChange={handleDomainChange}
          options={groupedOptions}
          placeholder="Select an assessment"
          disabled={disabled || isLoading}
          filteringType="auto"
          expandToViewport
        />
      )}
    </FormField>
  );
};
