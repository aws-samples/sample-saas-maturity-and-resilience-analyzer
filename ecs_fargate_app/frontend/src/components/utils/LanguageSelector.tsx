import React from 'react';
import { Button, ButtonDropdown } from '@cloudscape-design/components';
import { useLanguage } from '../../contexts/LanguageContext';
import { getLanguageByCode } from '../../i18n/languages';

export const LanguageSelector: React.FC = () => {
  const { language, setLanguage, strings, supportedLanguages } = useLanguage();

  // Generate language options dynamically from the supported languages
  const languageOptions = supportedLanguages.map(lang => {
    // Get the localized name of the language in current UI language
    const localizedName = lang.nativeName;
    
    return {
      id: lang.code,
      text: localizedName,
      description: lang.nativeName, // Native name (e.g., "English", "日本語", "Español")
    };
  });

  const currentLanguageOption = languageOptions.find(option => option.id === language);

  return (
    <ButtonDropdown
      items={languageOptions}
      variant="icon"
      ariaLabel={strings.language.select}
      onItemClick={({ detail }) => {
        const selectedLang = detail.id;
        if (supportedLanguages.some(lang => lang.code === selectedLang)) {
          setLanguage(selectedLang as any);
        }
      }}
    >
      {currentLanguageOption?.description || 'EN'}
    </ButtonDropdown>
  );
};

// Alternative simple button version for compact spaces
export const LanguageToggle: React.FC = () => {
  const { language, setLanguage, strings, supportedLanguages } = useLanguage();

  const toggleLanguage = () => {
    // Find the current language index
    const currentIndex = supportedLanguages.findIndex(lang => lang.code === language);
    
    // Get the next language in the array, cycling back to the first if at the end
    const nextIndex = (currentIndex + 1) % supportedLanguages.length;
    const nextLanguage = supportedLanguages[nextIndex].code;
    
    setLanguage(nextLanguage as any);
  };

  const currentLangDef = getLanguageByCode(language);
  const nextLangIndex = (supportedLanguages.findIndex(lang => lang.code === language) + 1) % supportedLanguages.length;
  const nextLangDef = supportedLanguages[nextLangIndex];
  
  // Create a dynamic aria label using the switchTo format string
  const ariaLabel = strings.language.switchTo.replace('{language}', nextLangDef.nativeName);

  return (
    <Button
      variant="inline-icon"
      iconName="globe"
      onClick={toggleLanguage}
      ariaLabel={ariaLabel}
    >
      {currentLangDef?.code.toUpperCase() || "EN"}
    </Button>
  );
};
